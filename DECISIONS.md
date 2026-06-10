# Decision Journal

Not a polished doc. Each entry is the rationale behind a choice or the
moment I changed my mind. The deadline ran from one working day, so a
few entries are honest cuts.

---

## D1. Three logical databases, one MongoClient

I almost reached for one MongoClient per tenant. That would have given
truly physical isolation — kill the client, kill the tenant — but it
blows the "max 10 concurrent MongoDB connections total" constraint
(spec §6) instantly: 3 clients × 10 conns each = 30, before BullMQ
adds its own. With 100 tenants in production it would be hopeless.

The MongoDB Node driver shares its pool across `client.db(name)` calls,
so a single `MongoClient(maxPoolSize=10)` services every tenant DB with
one shared pool. That keeps the constraint and still gives database-
level isolation: a query against `tenant_sunrise_001` physically
cannot return data from `tenant_metro_002` — it's a different
namespace, not a filter.

The third DB per tenant — `vault_<X>` — was a late addition. I
originally put the token-to-value map in `tenant_<X>.token_vault`.
Re-reading compliance §1 ("tokenization keys must be stored
separately from the data they protect") pushed me to split it out:
keys live in catalog, tokenized data in tenant_<X>, raw-value vault
in vault_<X>. Three places, three secrets, no single DB compromise
recovers a record.

**Alternatives considered:** (a) one MongoClient per tenant — rejected
on connection count, (b) row-level filter on a shared DB — explicitly
forbidden by spec §3.1 and CONSTRAINTS.md, (c) vault in catalog —
rejected because the catalog already holds the keys; co-locating
them weakens the "keys separate from data" guarantee.

---

## D2. AsyncLocalStorage for tenant context — not explicit threading

The thing the old system got wrong was that `clientId` was a function
argument. People forget arguments. Forgetfulness leaks tenants.

Two real options:
- **Explicit context**: pass `tenantId` into every function. Fast,
  type-safe, but one missing pass at one call site silently reads the
  wrong DB. Tests would still pass.
- **AsyncLocalStorage**: set context once at the request entry point;
  every accessor below reads from it; mis-passing is impossible because
  there is no parameter to pass.

I went with AsyncLocalStorage. The cost is a small runtime overhead and
a slightly weirder mental model. The benefit is that the rule "every
DB call uses the right tenant" is enforced by *the absence of a way to
do it wrong*. `tenant.borrowers()` doesn't take a tenantId; it can't.

This same pattern carries into the BullMQ worker — the worker calls
`runInContext({tenantId, ...})` before any DB call. A future
contributor who adds another job type physically cannot forget to set
the tenant.

I was wrong about something here: my first pass had `tenant.borrowers(tenantId)`
accept an optional override for admin cross-tenant queries. That override
re-introduced the "easy to mis-pass" hole. I changed it to `withActiveTenant(tenantId, fn)`
— admins still get cross-tenant access, but they have to wrap a block
to do it, and the wrapped block writes to the right DB by reading from
the store, not from an argument.

---

## D3. Format-preserving tokenization via HMAC, not real FPE

The textbook answer is FF1 or FF3 (NIST AES-FFX). Both are real
format-preserving encryption — keyed, reversible, exact-length.

I didn't use them. Reasons:

- I cannot explain FF1 or FF3 to depth in 5 minutes. The constraint
  says "if you can't explain how something in your system works,
  don't use it". I'd be reaching for a library I don't understand.
- The threat model here doesn't require FPE's security guarantees.
  We need (a) determinism per tenant, (b) per-tenant scoping,
  (c) reversibility for authorized roles, (d) length preservation.
  All four are satisfiable with HMAC + vault.

So: HMAC-SHA256(tenant_key, normalize(value)) → 32 bytes →
format-specific derivation → token. Reversibility via vault, not
via decryption. Two consequences:

- Tokens are **lookup-reversible**, not algorithm-reversible. Erasure
  is a vault delete, which makes tokens permanently irreversible —
  exactly what compliance §7 wants.
- The vault doubles as a uniqueness check. On every tokenize call,
  if the same token already maps to a different normalized value
  (vanishing in 10^10 space for our 700-borrower tenants but
  theoretically possible) we retry with a counter suffix.

I burned ~20 minutes here. My first implementation compared
`existing.value === raw` for collision detection, which broke
normalization equivalence: `"+91 99999 12345"` produced a different
token from `"9999912345"` because the stored `value` field was the
first raw form (`"9999912345"`) and the test's third call presented
the prefixed form, so I incorrectly thought a collision had occurred
and retried with a salt, getting a different token. Fixed by
comparing `normalize(existing.value)` instead. Test
`tokenization.test.ts > normalization makes formatting irrelevant`
catches this. Worth more than the time it cost.

---

## D4. Breach detection model — punish the *attempt*

For single-tenant roles, my design literally makes cross-tenant
reads impossible: their query gets pinned to their JWT tenant. So
"detecting a breach" isn't a thing they could ever succeed at.

But the spec wants detection. So I added an explicit attempt signal:
single-tenant roles can pass `?tenantId=X` on requests; if X differs
from their JWT tenant, that's a deliberate cross-tenant attempt. We:

1. Write a security-incident audit entry against the *requested*
   tenant (so they can see who tried to hit them).
2. Revoke the `jti`.
3. Return 403 with a generic message — no tenant name or borrower id
   in the response (verified in `isolation.test.ts > error responses
   don't leak`).

This satisfies compliance §5 (revoke session, log, flag) without
requiring an actual breach to ever succeed.

I left auto kill-all-sessions-of-the-user-on-breach unimplemented.
It would require tracking every active jti per user and revoking the
set on incident, or a pub/sub invalidation broadcast. Not in scope
for one working day; logged as a gap below.

---

## D5. I found 12 cross-tenant accesses in the seed access logs

Before I wrote a line of code I grepped the seed data. The pattern
in access_logs.json:

```
12 entries where users from client_sunrise_001 hit client_metro_002
resources — all returning HTTP 200. Spans every role.
```

That's the exact failure the new system is supposed to prevent. The
breach-detection test in `isolation.test.ts` is the inverse: same
scenario, system returns 403 + revokes the session + writes an
incident. If the reviewer wants to see "your system fixes the
incidents in the data", that's the story.

Same hunt also turned up **~10,000 agent messages outside 8AM–8PM
IST** in conversations.json — quiet-hours violations the old system
never blocked. The compliance report job counts these per tenant.

---

## D6. Migration found 11 orphan borrower records — and surfaces them

11 borrowers in `borrowers.json` have malformed/null `clientId`s:
`client_sunrise_01` (missing zero), `None`, `sunrise_001`,
`client_digital_004` (no such tenant), etc. The old shared-DB system
happily stored them — separation was by clientId field, no validation.

I initially treated this as a test bug ("expected 2013, got 2002")
and was about to add a tolerance. Then I read the records and
realized this is the spec's hint about "evidence of past failures" —
data integrity drift the new system should detect, not paper over.

Migration now returns `orphans: { borrowers, conversations, payments,
accessLogs }` so the orphan counts surface explicitly. The test
asserts `valid + orphan == source count` (no silent drops) AND
`orphan > 0` (we noticed, we didn't hide). Logged at INFO during
migrate.

What I'd build with more time: an admin endpoint to review and
re-tenant orphan records (route them to the right tenant by name
match or quarantine them).

---

## D7. Things I intentionally did NOT build

1. **Scheduled task: daily overdue payment check.** Design: a
   BullMQ repeatable job that iterates `catalog.tenants` and enqueues
   one fan-out job per tenant; each handler calls `runInContext` for
   its tenantId and runs the check. Pattern is identical to the
   compliance report; no new surface. Cut for time.

2. **90-day PII purge for closed accounts.** Design: cron-driven
   sweep that finds borrowers with `status = "closed"` and
   `closedAt < now - 90d`, then deletes their vault entries (making
   their tokens permanently irreversible) and writes tombstone audit
   entries. Vault delete is already implemented as a primitive;
   the sweeper isn't.

3. **Right-to-erasure admin endpoint.** Same building block as #2,
   different trigger.

4. **Auto kill-all-sessions-of-user on breach.** Currently I revoke
   the offending jti only. Cross-session kill needs either tracking
   every issued jti per user (extra catalog state) or a pub/sub
   invalidation channel. Documented gap.

5. **Mongoose / any "multi-tenant" plugin.** CONSTRAINTS.md
   explicitly forbids auto-scoping plugins, and a plugin is exactly
   the surface where I'd lose the AsyncLocalStorage guarantee.

6. **Rate limiting / DDoS.** Out of scope for a local-only assessment.

7. **TLS / reverse proxy.** Same.

8. **Tenant key rotation.** Keys are immutable per tenant. Rotation
   would require a `keyVersion` on every vault row and a re-tokenize
   batch job. Not in scope.

9. **Tests for the webhook HMAC signature path.** I smoke-tested it
   manually. A proper test would build a signed request and assert
   the payment row lands in the right tenant DB. Would have added
   it with another hour.

---

## D8. Stuck moment: I forgot the email lowercasing

First login attempt as a seed user returned 401. The seed JSON has
mixed-case emails (`Manoj.Bose@gmail.com` in one record); my login
handler did `findOne({ email: email.toLowerCase() })`. Migration
stored the email as `u.email` (mixed case) → user lookup failed.

Fix: migration now stores `email: u.email.toLowerCase()`. Two-line
change. The lesson: write the path from user input to DB row first,
then make sure the round-trip works before touching anything else.

---

## D9. Stuck moment: insertMany silent drops

The migration sometimes printed `701 borrowers ingested` for sunrise
when the seed has 712 in that tenant (after filtering orphans, 701
is correct). My initial test asserted equality with the raw source
count of 2013 → failed by 11. I thought the `ordered: false` insert
was silently dropping duplicates. It wasn't — `insertMany` with
`ordered: false` still throws on a write error, just keeps going
through the rest of the batch. The real cause was orphans (D6).
Test that surfaced this: `migration.test.ts > ingest accounts for
every record`. Could have saved time by counting orphan candidates
first.
