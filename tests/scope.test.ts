import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrap, teardown, login, SEED, type Bootstrap } from "./helpers.js";

describe("debt-counselor scope enforcement at data layer", () => {
  let b: Bootstrap;

  beforeAll(async () => { b = await bootstrap(); }, 60_000);
  afterAll(async () => { await teardown(); });

  it("counselor cannot read another counselor's borrower in the same tenant — returns 404, not filtered", async () => {
    const token = await login(b.api, SEED.sunriseCounselorAjay.email);
    const res = await b.api
      .get(`/borrowers/${SEED.sunriseCounselorHitesh.ownBorrower}`)
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("counselor list only contains their own assigned borrowers", async () => {
    const token = await login(b.api, SEED.sunriseCounselorAjay.email);
    const res = await b.api.get("/borrowers?limit=200").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.borrowers.length).toBeGreaterThan(0);
    for (const b0 of res.body.borrowers) {
      expect(b0.assignedTo).toBe(SEED.sunriseCounselorAjay.userId);
    }
  });

  it("counselor can read their own borrower with the expected masking", async () => {
    const token = await login(b.api, SEED.sunriseCounselorAjay.email);
    const res = await b.api
      .get(`/borrowers/${SEED.sunriseCounselorAjay.ownBorrower}`)
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const borrower = res.body.borrower;
    // Counselor sees name + phone in full (detokenized)
    expect(borrower.firstName).toBe("Pankaj");
    expect(borrower.phone).toBe("7936043811");
    // Counselor sees aadhaar/PAN/bankAccount as masked tokens — format preserved but not original
    expect(borrower.aadhaar).toMatch(/^\d{12}$/);
    expect(borrower.aadhaar).not.toBe("189966462838");
    expect(borrower.pan).toMatch(/^[A-Z]{5}\d{4}[A-Z]$/);
    expect(borrower.bankAccount).toMatch(/^\d+$/);
  });

  it("counselor cannot read payments belonging to another counselor's borrower", async () => {
    const token = await login(b.api, SEED.sunriseCounselorAjay.email);
    const res = await b.api
      .get(`/payments/${SEED.sunriseCounselorHitesh.ownBorrower}`)
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("counselor cannot read conversations belonging to another counselor's borrower", async () => {
    const token = await login(b.api, SEED.sunriseCounselorAjay.email);
    const res = await b.api
      .get(`/conversations/${SEED.sunriseCounselorHitesh.ownBorrower}`)
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
