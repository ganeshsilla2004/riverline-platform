import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrap, teardown, login, SEED, type Bootstrap } from "./helpers.js";

const BORROWER = "709dc7f4-65f0-4791-b4a7-367092ba16da"; // assigned to Ajay (sunrise counselor)
const RAW_NAME = "Pankaj";
const RAW_AADHAAR = "189966462838";

describe("role-based PII masking", () => {
  let b: Bootstrap;

  beforeAll(async () => { b = await bootstrap(); }, 60_000);
  afterAll(async () => { await teardown(); });

  it("admin sees fully detokenized PII", async () => {
    const token = await login(b.api, SEED.sunriseAdmin.email);
    const res = await b.api.get(`/borrowers/${BORROWER}`).set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const borrower = res.body.borrower;
    expect(borrower.firstName).toBe(RAW_NAME);
    expect(borrower.aadhaar).toBe(RAW_AADHAAR);
    expect(borrower.pan).toBe("CMBTT1452T");
  });

  it("debt-counselor sees full name + phone but tokenized aadhaar/PAN/bankAccount", async () => {
    const token = await login(b.api, SEED.sunriseCounselorAjay.email);
    const res = await b.api.get(`/borrowers/${BORROWER}`).set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const borrower = res.body.borrower;
    expect(borrower.firstName).toBe(RAW_NAME);
    expect(borrower.phone).toBe("7936043811");
    expect(borrower.aadhaar).not.toBe(RAW_AADHAAR);
    expect(borrower.aadhaar).toMatch(/^\d{12}$/);
    expect(borrower.bankAccount).toMatch(/^\d+$/);
  });

  it("engineer sees no PII values (all masked or omitted)", async () => {
    const token = await login(b.api, SEED.sunriseEngineer.email);
    const res = await b.api
      .get(`/borrowers/${BORROWER}?tenantId=${SEED.sunriseAdmin.clientId}`)
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const borrower = res.body.borrower;
    // engineer: name/phone/email masked, aadhaar/pan/bankAccount OMITTED
    expect(borrower.firstName).not.toBe(RAW_NAME);
    expect(borrower.phone).not.toBe("7936043811");
    expect(borrower.email).not.toContain("@outlook.com");
    expect(borrower).not.toHaveProperty("aadhaar");
    expect(borrower).not.toHaveProperty("pan");
    expect(borrower).not.toHaveProperty("bankAccount");
  });

  it("client-viewer sees partial PII and omitted sensitive fields", async () => {
    const token = await login(b.api, SEED.sunriseViewer.email);
    const res = await b.api.get(`/borrowers/${BORROWER}`).set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const borrower = res.body.borrower;
    expect(borrower.phone).toMatch(/^\*+\d{4}$/);
    expect(borrower).not.toHaveProperty("aadhaar");
    expect(borrower).not.toHaveProperty("pan");
    expect(borrower).not.toHaveProperty("bankAccount");
  });
});
