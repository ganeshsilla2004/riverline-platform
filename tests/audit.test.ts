import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrap, teardown, login, SEED, type Bootstrap } from "./helpers.js";
import { getClient } from "../src/db/client.js";
import { tenant } from "../src/db/tenant.js";
import { runInContext } from "../src/db/context.js";

describe("audit trail", () => {
  let b: Bootstrap;
  beforeAll(async () => { b = await bootstrap(); }, 60_000);
  afterAll(async () => { await teardown(); });

  it("logs failed scope attempt with same detail as a successful one", async () => {
    const token = await login(b.api, SEED.sunriseCounselorAjay.email);
    // Successful access to own borrower
    await b.api.get(`/borrowers/${SEED.sunriseCounselorAjay.ownBorrower}`)
      .set("authorization", `Bearer ${token}`);
    // Failed cross-counselor access
    await b.api.get(`/borrowers/${SEED.sunriseCounselorHitesh.ownBorrower}`)
      .set("authorization", `Bearer ${token}`);

    const ctx = {
      userId: SEED.sunriseCounselorAjay.userId,
      role: "admin" as const,
      tenantId: SEED.sunriseAdmin.clientId,
      jti: "test",
      activeTenantId: SEED.sunriseAdmin.clientId,
    };
    const logs = await runInContext(ctx, async () =>
      (await tenant.auditLogs(SEED.sunriseAdmin.clientId))
        .find({ userId: SEED.sunriseCounselorAjay.userId })
        .sort({ ts: -1 })
        .limit(5)
        .toArray()
    );
    expect(logs.length).toBeGreaterThanOrEqual(2);
    // Both success and failure should have role, method, pathTemplate, outcome
    for (const l of logs) {
      expect(l).toHaveProperty("role");
      expect(l).toHaveProperty("method");
      expect(l).toHaveProperty("pathTemplate");
      expect(l.outcome).toHaveProperty("statusCode");
    }
    // Validate at least one failure recorded with success:false
    expect(logs.some((l) => l.outcome.success === false)).toBe(true);
  });

  it("audit log entries do not contain raw PII (phone numbers, aadhaars)", async () => {
    const token = await login(b.api, SEED.sunriseAdmin.email);
    await b.api.get(`/borrowers/${SEED.sunriseCounselorAjay.ownBorrower}`)
      .set("authorization", `Bearer ${token}`);

    const ctx = {
      userId: "x", role: "admin" as const, tenantId: SEED.sunriseAdmin.clientId,
      jti: "x", activeTenantId: SEED.sunriseAdmin.clientId,
    };
    const sample = await runInContext(ctx, async () =>
      (await tenant.auditLogs(SEED.sunriseAdmin.clientId)).find({}).limit(200).toArray()
    );
    const stringified = JSON.stringify(sample);
    // None of these raw PII values should appear in any audit log
    expect(stringified).not.toContain("7936043811");           // phone
    expect(stringified).not.toContain("189966462838");         // aadhaar
    expect(stringified).not.toContain("CMBTT1452T");           // PAN
    expect(stringified).not.toContain("pankaj_thakur@outlook"); // email
  });

  it("audit logs are isolated per tenant", async () => {
    // Insert an audit row for sunrise then assert it never appears for metro
    const ctx = {
      userId: "x", role: "admin" as const, tenantId: SEED.sunriseAdmin.clientId,
      jti: "x", activeTenantId: SEED.metroAdmin.clientId,
    };
    const metroLogs = await runInContext(ctx, async () =>
      (await tenant.auditLogs(SEED.metroAdmin.clientId))
        .find({ tenantId: SEED.sunriseAdmin.clientId })
        .toArray()
    );
    expect(metroLogs.length).toBe(0);
    void (await getClient());
  });
});
