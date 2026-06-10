# Riverline Backend Platform — Take-Home Assessment

A secure, multi-tenant data platform for debt collection. Replaces the
broken shared-DB system described in `../assessment/spec.md`.

## Quick start

Requires Docker.

```bash
docker compose up --build
```

`docker compose up` brings up MongoDB, Redis, the API (port 3000), and the
BullMQ worker. On first boot the API auto-runs the migration (idempotent —
controlled by `AUTO_MIGRATE=true`). Health check: `curl localhost:3000/health`.

Without Docker, against a local Mongo + Redis on default ports:

```bash
npm install
npm run migrate          # ingest seed-data/, < 60s
npm start                # in one terminal
npm run start:worker     # in another terminal
npm test                 # run the adversarial test suite
```

Reset state:

```bash
npm run migrate:reverse  # drops every tenant + vault DB and the catalog
```

## Endpoints

All endpoints except `/health`, `/auth/login`, and `/webhooks/payment-gateway`
require a `Bearer` token. Seed users all share the password `password123`
(set via `SEED_USER_PASSWORD`).

| Method | Path                                          | Notes |
|--------|-----------------------------------------------|-------|
| POST   | `/auth/login`                                 | `{ email, password }` → `{ token, user }` |
| POST   | `/borrowers`                                  | admin only |
| GET    | `/borrowers`                                  | scoped by role; counselors only see their `assignedTo` |
| GET    | `/borrowers/:id`                              | PII masked per role |
| PUT    | `/borrowers/:id`                              | admin + counselor (own only) |
| GET    | `/conversations/:borrowerId`                  | scope + masking applies |
| POST   | `/conversations/:borrowerId/messages`         | 20:00–08:00 IST blocked |
| POST   | `/payments`                                   | admin + counselor |
| GET    | `/payments/:borrowerId`                       | scope-enforced |
| POST   | `/reports/compliance`                         | enqueues BullMQ job → 202 |
| GET    | `/reports/compliance`                         | latest report doc |
| POST   | `/webhooks/payment-gateway`                   | HMAC-signed; tenant from reference |
| GET    | `/audit-logs`                                 | admin + engineer |
| GET    | `/health`                                     | no auth |

Multi-tenant roles (admin, engineer) target a tenant with `?tenantId=...`.
Single-tenant roles (debt-counselor, client-viewer) MUST NOT pass a
different `tenantId` — doing so is a deliberate cross-tenant attempt and
will revoke the session (see §3.5 of `ARCHITECTURE.md`).

## Role matrix

| Role             | Scope                                | PII visibility |
|------------------|--------------------------------------|----------------|
| `admin`          | all tenants                          | full (detokenized) |
| `debt-counselor` | own tenant, own `assignedTo` only    | name + phone full; aadhaar/PAN/bank masked |
| `engineer`       | all tenants, read                    | name/phone/email masked; aadhaar/PAN/bank omitted |
| `client-viewer`  | own tenant, read, aggregate          | name masked, phone/email partial; aadhaar/PAN/bank omitted |

## Smoke test (after `docker compose up`)

```bash
B=http://localhost:3000

# Admin sees full PII
T=$(curl -s -X POST $B/auth/login -H 'content-type: application/json' \
       -d '{"email":"manoj.bose@gmail.com","password":"password123"}' \
     | jq -r .token)
curl -s -H "authorization: Bearer $T" "$B/borrowers?limit=1" | jq .

# Counselor scope is enforced — accessing another counselor's borrower returns 404
T=$(curl -s -X POST $B/auth/login -H 'content-type: application/json' \
       -d '{"email":"ajay.menon@hotmail.com","password":"password123"}' \
     | jq -r .token)
curl -sw "\n%{http_code}\n" -H "authorization: Bearer $T" \
  "$B/borrowers/1c3a794b-e55f-4189-9a67-8fade6b3e4fa"
# → {"error":"not found"} 404

# Cross-tenant attempt → 403, session revoked
curl -sw "\n%{http_code}\n" -H "authorization: Bearer $T" \
  "$B/borrowers/3b6e0438-354c-4a01-801a-4ab741d14b66?tenantId=client_metro_002"
# → {"error":"forbidden"} 403
curl -sw "\n%{http_code}\n" -H "authorization: Bearer $T" "$B/borrowers"
# → {"error":"unauthorized"} 401  (jti revoked)
```

## Tests

```bash
docker compose up -d mongo redis    # tests reuse the local stack
npm test
```

Adversarial suite (7 files, 34 tests):

- `isolation.test.ts` — cross-tenant attempts denied + session revoked
- `scope.test.ts` — debt-counselor cannot read other counselors' borrowers
- `tokenization.test.ts` — deterministic, format-preserving, per-tenant
- `masking.test.ts` — 4-role × 6-PII-field visibility matrix
- `audit.test.ts` — no PII in audit logs, per-tenant isolation, failures recorded
- `resilience.test.ts` — one failing tenant doesn't cascade
- `migration.test.ts` — < 60s; valid + orphan == seed count; idempotent; reversible

## Layout

```
platform/
├── docker-compose.yml
├── Dockerfile
├── ARCHITECTURE.md         ← design rationale
├── DECISIONS.md            ← decision journal
├── src/
│   ├── index.ts            API entrypoint
│   ├── worker.ts           BullMQ worker entrypoint
│   ├── server.ts           Express composition
│   ├── db/                 connection pool, contexts, catalog/tenant/vault accessors
│   ├── auth/               JWT, bcrypt, middleware, login
│   ├── rbac/               roles, policy, scope, masking
│   ├── pii/                normalize, tokenizer, fields registry
│   ├── audit/              append-only audit logger
│   ├── routes/             all 12 endpoints
│   ├── jobs/               BullMQ queue + compliance report handler
│   ├── migration/          seed.ts + reverse.ts
│   └── lib/                errors, AES-GCM crypto helper
└── tests/
```

See `ARCHITECTURE.md` for the design and `DECISIONS.md` for the journal.
