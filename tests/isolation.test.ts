import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrap, teardown, login, SEED, type Bootstrap } from "./helpers.js";

describe("tenant isolation", () => {
  let b: Bootstrap;

  beforeAll(async () => { b = await bootstrap(); }, 60_000);
  afterAll(async () => { await teardown(); });

  it("blocks single-tenant role with explicit cross-tenant query and revokes session", async () => {
    const token = await login(b.api, SEED.sunriseCounselorAjay.email);
    // The borrower exists in metro_002, not in sunrise_001. The counselor's
    // token claims sunrise; specifying ?tenantId=metro is a deliberate
    // cross-tenant attempt and MUST trigger breach response.
    const breach = await b.api
      .get(`/borrowers/${SEED.metroBorrowerSample}?tenantId=${SEED.metroAdmin.clientId}`)
      .set("authorization", `Bearer ${token}`);
    expect(breach.status).toBe(403);
    expect(breach.body.error).toBe("forbidden");
    // Token MUST now be revoked.
    const retry = await b.api.get("/borrowers").set("authorization", `Bearer ${token}`);
    expect(retry.status).toBe(401);
  });

  it("breach detection covers conversations endpoint too", async () => {
    const token = await login(b.api, SEED.sunriseCounselorAjay.email);
    const breach = await b.api
      .get(`/conversations/${SEED.metroBorrowerSample}?tenantId=${SEED.metroAdmin.clientId}`)
      .set("authorization", `Bearer ${token}`);
    expect(breach.status).toBe(403);
  });

  it("counselor cannot read metro borrower data via tenantId override on payments", async () => {
    const token = await login(b.api, SEED.sunriseCounselorAjay.email);
    const breach = await b.api
      .get(`/payments/${SEED.metroBorrowerSample}?tenantId=${SEED.metroAdmin.clientId}`)
      .set("authorization", `Bearer ${token}`);
    expect(breach.status).toBe(403);
  });

  it("client-viewer cannot escape its home tenant either", async () => {
    const token = await login(b.api, SEED.sunriseViewer.email);
    const breach = await b.api
      .get(`/borrowers?tenantId=${SEED.metroAdmin.clientId}`)
      .set("authorization", `Bearer ${token}`);
    expect(breach.status).toBe(403);
  });

  it("admin (multi-tenant role) CAN legitimately access another tenant when specified", async () => {
    const token = await login(b.api, SEED.sunriseAdmin.email);
    const res = await b.api
      .get(`/borrowers/${SEED.metroBorrowerSample}?tenantId=${SEED.metroAdmin.clientId}`)
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.borrower.borrowerId).toBe(SEED.metroBorrowerSample);
  });

  it("error responses don't leak tenant identifiers", async () => {
    const token = await login(b.api, SEED.sunriseCounselorAjay.email);
    const res = await b.api
      .get(`/borrowers/${SEED.metroBorrowerSample}?tenantId=${SEED.metroAdmin.clientId}`)
      .set("authorization", `Bearer ${token}`);
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain(SEED.metroAdmin.clientId);
    expect(bodyText).not.toContain(SEED.metroBorrowerSample);
  });
});
