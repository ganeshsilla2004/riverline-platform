import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrap, teardown } from "./helpers.js";
import { tokenize, detokenize, clearKeyCache } from "../src/pii/tokenizer.js";

describe("PII tokenizer", () => {
  beforeAll(async () => { await bootstrap(); }, 60_000);
  afterAll(async () => { clearKeyCache(); await teardown(); });

  it("is deterministic within a tenant (same value → same token)", async () => {
    const a = await tokenize("client_sunrise_001", "phone", "9999900001");
    const b = await tokenize("client_sunrise_001", "phone", "9999900001");
    expect(a).toBe(b);
  });

  it("produces different tokens across tenants for the same value", async () => {
    const a = await tokenize("client_sunrise_001", "phone", "9999900002");
    const b = await tokenize("client_metro_002", "phone", "9999900002");
    expect(a).not.toBe(b);
  });

  it("phone token is 10 digits", async () => {
    const t = await tokenize("client_sunrise_001", "phone", "9999900003");
    expect(t).toMatch(/^\d{10}$/);
  });

  it("aadhaar token is 12 digits", async () => {
    const t = await tokenize("client_sunrise_001", "aadhaar", "111122223333");
    expect(t).toMatch(/^\d{12}$/);
  });

  it("pan token matches AAAAA9999A shape", async () => {
    const t = await tokenize("client_sunrise_001", "pan", "ABCDE1234F");
    expect(t).toMatch(/^[A-Z]{5}\d{4}[A-Z]$/);
  });

  it("email token has @masked.local domain", async () => {
    const t = await tokenize("client_sunrise_001", "email", "alice@example.com");
    expect(t).toMatch(/@masked\.local$/);
  });

  it("bank account token preserves digit length", async () => {
    const v = "1234567890123456";
    const t = await tokenize("client_sunrise_001", "bankAccount", v);
    expect(t).toMatch(/^\d{16}$/);
  });

  it("normalization makes formatting irrelevant (phone with spaces == phone without)", async () => {
    const a = await tokenize("client_sunrise_001", "phone", "9999912345");
    const b = await tokenize("client_sunrise_001", "phone", "99999 12345");
    const c = await tokenize("client_sunrise_001", "phone", "+91 99999 12345");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("vault round-trips a token back to the original value", async () => {
    const raw = "9876543210";
    const t = await tokenize("client_sunrise_001", "phone", raw);
    expect(t).not.toBe(raw);
    const detok = await detokenize("client_sunrise_001", t);
    expect(detok).toBe(raw);
  });

  it("token detokenized in tenant A does not detokenize in tenant B", async () => {
    const raw = "9876543200";
    const tokA = await tokenize("client_sunrise_001", "phone", raw);
    const inB = await detokenize("client_metro_002", tokA);
    expect(inB).toBeNull();
  });
});
