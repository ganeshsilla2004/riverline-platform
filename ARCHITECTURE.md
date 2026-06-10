# Architecture

## Overview

```
                                ┌──────────────┐
   client ── HTTP ──▶ API ──┐   │   MongoDB    │
                            │   │              │
   webhook ─ HTTP ──▶ API   ├──▶│ platform_    │   ◀── ONE MongoClient,
                            │   │ catalog      │       maxPoolSize=10,
   admin tools ─ HTTP ──▶ API   │              │       shared across all DBs.
                            │   │ tenant_<X>   │
                            │   │ vault_<X>    │   ◀── three logical
   /reports/compliance  ─▶ API  │              │       layers, three
                       enqueue  │ tenant_<Y>   │       physical DBs per
                       BullMQ   │ vault_<Y>    │       tenant.
                            │   │              │
                       ┌────┴───┴── Redis ──── BullMQ Worker ─▶ MongoDB
                       │                       (separate process, same image)
                       └─ runInContext(tenantId, ...) before any DB call
```

The platform is a single Node.js codebase with two entrypoints
(`src/index.ts` API, `src/worker.ts` BullMQ worker), one MongoDB, and one
Redis. All three run under one `docker compose up`.

## 1. Three-layer database separation

Three logical DB namespaces serve three different concerns, all backed by
ONE `MongoClient` (`src/db/client.ts`, `maxPoolSize=10`). MongoDB's driver
shares its connection pool across `client.db(name)` calls, so we satisfy
the "max 10 connections" constraint while having one DB per tenant.

| DB name                       | Contents                                              | Why separated |
|-------------------------------|-------------------------------------------------------|---------------|
| `platform_catalog`            | tenants registry, users (auth), tenant_keys (wrapped), revoked_sessions | control plane — no tenant data |
| `tenant_<clientId>`           | borrowers, conversations, payments, audit_logs, reports — **tokenized PII only** | spec §3.1: per-tenant DBs, not row filtering |
| `vault_<clientId>`            | tokens collection: token → raw value mapping          | compliance §1: "tokenization keys must be stored separately from the data they protect" — the vault is physically separate from `tenant_<X>` |

Tenant keys themselves (AES-GCM-wrapped 32-byte HMAC keys) live in the
catalog only; the vault holds the token-value pairs but not the keys. Three
secrets in three places must be combined to recover a single value: the
`PLATFORM_KEY` env var, the catalog row, and the vault row.

## 2. Tenant context propagation

`src/db/context.ts` exposes a single `AsyncLocalStorage<TenantContext>`
that every DB accessor reads from. Crucially, no DB accessor takes
`tenantId` as a function argument — context is the only path. Callers
cannot accidentally route to the wrong tenant DB because there is no
parameter to mis-pass.

Three places populate the store:

1. **HTTP middleware** (`src/auth/middleware.ts`): JWT verified, `jti`
   checked against `catalog.revoked_sessions`, then context set from JWT
   claims. The handler chain runs inside `runInContext(...)`.

2. **BullMQ worker** (`src/jobs/complianceReport.ts`): the job consumer
   reads `tenantId` from `job.data` (placed there at enqueue time) and
   wraps the entire job body in `runInContext({ tenantId, ... })`.
   The worker has no other source of tenant identity, so background work
   for tenant A is physically incapable of touching tenant B's DB.

3. **Webhook handler** (`src/routes/webhooks.ts`): no JWT. The signed
   payload includes a `reference` field whose prefix maps to a tenant in
   `catalog.tenants`. Resolution happens after HMAC verification; the
   handler then `runInContext({ tenantId, role: "admin", ... })`.

Routes that accept a `:borrowerId` or `:id` use a helper
(`src/routes/_helpers.ts::resolveTenant`) that:

- For single-tenant roles (`debt-counselor`, `client-viewer`): if the
  request specifies `?tenantId=X` and `X !== JWT.tenantId`, write a
  security audit entry, revoke the session jti, return 403. Otherwise
  use `JWT.tenantId`. The caller physically cannot read another tenant's
  DB; the breach response exists to **detect and punish the attempt**.
- For multi-tenant roles (`admin`, `engineer`): `?tenantId=X` chooses
  the target tenant; absence falls back to JWT.tenantId.

## 3. PII tokenization

`src/pii/tokenizer.ts`. Format-preserving and deterministic per tenant.

```
norm  = normalize(fieldType, raw)
seed  = HMAC-SHA256(tenant_key, norm)
token = formatDerive(seed, fieldType)
```

`formatDerive` produces:
- phone (10 digits): `bigint(seed[0..8]) % 10^10`, zero-padded
- aadhaar (12 digits): `bigint(seed[0..8]) % 10^12`, zero-padded
- bank account: `bigint(seed[0..8]) % 10^len(raw)`, padded to original length
- PAN: 5 letters + 4 digits + 1 letter derived from seed bytes
- email: `<hex8>@masked.local`
- name: two syllables from a fixed 30-item dictionary indexed by seed bytes

On first encounter, the token-to-raw mapping is upserted to
`vault_<tenant>.tokens`. Subsequent lookups by raw value re-derive the
same token; reversibility uses the vault.

**Properties** (verified in `tokenization.test.ts`):

| Property | Mechanism |
|----------|-----------|
| Deterministic per tenant | HMAC with fixed tenant key |
| Format-preserving | format-specific derivation from seed bytes |
| Reversible (by authorized roles) | vault lookup by token |
| Per-tenant scoped | each tenant has its own key; same raw → different tokens across tenants |
| Erasure (compliance §7) | delete vault row → token becomes permanently irreversible |

Normalization (`src/pii/normalize.ts`) ensures formatting variations of
the same canonical value produce the same token: `"+91 99999 12345"` and
`"9999912345"` collapse to one token. Collision detection compares the
normalized form of an existing vault entry against the new input's
normalized form — anything else triggers a retry with a salt counter.

## 4. Auth & RBAC

Custom, no frameworks. Allowed primitives only (`jsonwebtoken`, `bcrypt`).

- **JWT** (`src/auth/jwt.ts`): HS256, 1h expiry, payload
  `{ sub, role, tenantId, jti, exp }`.
- **Password**: bcrypt cost-10. Seed users get the password from
  `SEED_USER_PASSWORD` (default `password123`, **test only**).
- **Role matrix** (`src/rbac/roles.ts`): deny-by-default permission
  table indexed by `Action`. Unknown role + unknown action = denied.
- **Scope enforcement at data layer** (`src/rbac/scope.ts`): the
  borrower query helper takes the current context and **rewrites the
  Mongo filter** to add `{ assignedTo: userId }` for debt-counselors.
  Out-of-scope documents are never returned by the database — this is
  spec §3.3's "enforce at the data layer, deny don't filter".
- **Masking** (`src/rbac/masking.ts`): each PII field has a per-role
  visibility level (full / partial / masked / omitted). The masker
  detokenizes via vault only for `full`. Unauthorized fields are
  **omitted** from the JSON response entirely, not replaced with
  placeholders (compliance §4: data minimization).

## 5. Audit trail

`src/audit/logger.ts` exports exactly one function — `writeAudit()`. It
inserts into `tenant_<X>.audit_logs`. There is no exported update or
delete path; the module's surface forbids tampering through normal code.

Audit entry shape:

```ts
{ ts, userId, role, tenantId, method, pathTemplate, resourceIds,
  maskingLevel, outcome: { statusCode, success, reason? }, jti, securityIncident? }
```

- `pathTemplate` is the route shape (`/borrowers/:id`), not the realized
  URL — borrowerId is in `resourceIds` instead. This honors compliance
  §6: "if an endpoint URL contains PII, the audit record must redact it".
- Audit logs are per-tenant and never queried cross-tenant; an admin
  hitting `GET /audit-logs?tenantId=X` returns logs for X only.
- Failed access attempts are written by the global error handler in
  `src/server.ts` with the same field set as successes (spec §3.4).
- Migration also imports the seed `access_logs.json` as **historical**
  audit entries (marked `historical: true`) — preserves the audit
  history that exposed the original system's failures (see DECISIONS).

## 6. Async paths

- **Background job — compliance report** (`src/jobs/complianceReport.ts`):
  POST `/reports/compliance` enqueues `{ tenantId, requestedBy, reportId }`.
  Worker calls `runInContext({ tenantId, ... })` first, then runs counts
  per the report (borrowers, payments-30d, quiet-hours violations, DPD
  bucket distribution). Result written to `tenant_<X>.reports`.
- **Webhook — payment gateway** (`src/routes/webhooks.ts`): no JWT.
  HMAC-SHA256 over raw body using `WEBHOOK_SECRET`. Tenant identity
  parsed from `reference: PAY-<clientId-prefix>-<uuid>`, resolved
  against catalog. Idempotent upsert by reference.

## 7. Migration

`src/migration/seed.ts`:

1. Read all 6 seed JSONs once.
2. Bulk-insert catalog `tenants`, generate + AES-GCM-wrap tokenization
   keys, bcrypt-hash the shared seed password once, bulk-insert users.
3. **In parallel per tenant** (Promise.all over the 3 tenants):
   tokenize all PII fields on borrowers; tokenize phone-number-shaped
   strings inside conversation message text; copy payments as-is;
   reduce access_logs into the new audit_log shape.
4. **Orphan detection**: records whose `clientId` does not match any
   catalog tenant are surfaced as a data-quality finding in the
   migration result. (11 borrowers in the seed have malformed clientIds
   like `client_sunrise_01` or `None` — the old shared-DB system
   tolerated these; the new system rejects them. See DECISIONS.)
5. Batch `insertMany` with `ordered: false`, chunks of 200–500.
6. Idempotent: if catalog already has tenants, returns `skipped: true`.

Observed runtime against the provided seed: **~2.4 seconds** (60s budget).

`src/migration/reverse.ts`: drops every `tenant_<X>` and `vault_<X>` DB,
then drops the catalog. Used as the rollback path and in tests for clean
state between runs.

**Zero-downtime claim**: the migration writes to fresh `tenant_<X>` and
`vault_<X>` DBs. The (hypothetical) old shared DB is never read or
modified. Cutover is at the API layer — the old API can continue
serving until the new one is fully primed. We don't include the old API
in this submission, but the property holds: nothing in `migrate()`
touches a shared collection.

## 8. Resilience

Every DB call is in an async function that already rejects on Mongo
network errors. The global error handler (`src/server.ts`) catches
those and returns a generic 503 / 500 with **no internal state in the
message**. Other tenants are unaffected because each request resolves
its tenant first and reads only that tenant's DB. The
`resilience.test.ts` test mocks the sunrise borrowers accessor to throw
a `MongoNetworkError` and verifies metro requests continue to return
200, and that the sunrise error response contains neither the tenant
name nor the underlying error class.

## 9. Tradeoffs & explicit non-goals

- **Mongoose vs native driver**: chose native driver. Mongoose is a
  query interface, but its hooks are exactly the surface where a
  "multi-tenant Mongoose plugin" would do auto-scoping — which
  CONSTRAINTS.md forbids. Native driver is more verbose but the rules
  are visible in `scope.ts`, not buried in plugin hooks.
- **Tenant key cache**: keys are unwrapped on first use per tenant and
  cached in process memory. Cache is invalidated on `clearKeyCache()`
  (used by migration teardown and tests). In production this cache
  would have a TTL and rotation hooks. Documented in DECISIONS.
- **Detokenization endpoint**: deliberately omitted. The only path that
  reveals raw PII is `GET /borrowers/:id` as admin — there is no
  generic `/detokenize` endpoint. Reduces blast radius if any other
  endpoint's auth ever weakens.
- **Scheduled tasks** (e.g., daily overdue check): designed (BullMQ
  repeatable job + per-tenant fanout) but not implemented. See
  DECISIONS for what was cut and why.
- **90-day PII purge for closed accounts** and the full right-to-
  erasure admin endpoint: vault-delete primitive exists, the admin
  workflow does not. Documented in DECISIONS.
- **Auto kill-all-sessions-of-user on breach**: current implementation
  revokes only the offending `jti`. Killing every outstanding session
  for a user would require iterating `revoked_sessions` or pub/sub
  invalidation. Documented as a known gap.
