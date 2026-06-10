import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { bootstrap, teardown, login, SEED, type Bootstrap } from "./helpers.js";
import * as tenantModule from "../src/db/tenant.js";

describe("resilience: one tenant failing must not affect another", () => {
  let b: Bootstrap;
  beforeAll(async () => { b = await bootstrap(); }, 60_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await teardown();
  });

  it("other tenants still respond when one tenant's borrowers collection throws", async () => {
    // Sabotage sunrise borrowers accessor — calling this for sunrise will throw,
    // simulating an underlying DB outage for that tenant only.
    const original = tenantModule.tenant.borrowers;
    const spy = vi.spyOn(tenantModule.tenant, "borrowers").mockImplementation(async (tid?: string) => {
      const t = tid ?? "client_sunrise_001";
      if (t === "client_sunrise_001") {
        const err = new Error("MongoNetworkError: connection refused");
        (err as Error & { name: string }).name = "MongoNetworkError";
        throw err;
      }
      return original.call(tenantModule.tenant, t);
    });

    const sunriseToken = await login(b.api, SEED.sunriseAdmin.email);
    const metroToken = await login(b.api, SEED.metroAdmin.email);

    // Sunrise request → 500 with generic message, NO tenant info leaked
    const sunriseRes = await b.api.get("/borrowers")
      .set("authorization", `Bearer ${sunriseToken}`);
    expect(sunriseRes.status).toBe(500);
    expect(JSON.stringify(sunriseRes.body)).not.toContain("client_sunrise_001");
    expect(JSON.stringify(sunriseRes.body)).not.toContain("MongoNetworkError");

    // Metro request should STILL succeed
    const metroRes = await b.api.get("/borrowers?limit=2")
      .set("authorization", `Bearer ${metroToken}`);
    expect(metroRes.status).toBe(200);
    expect(metroRes.body.borrowers.length).toBeGreaterThan(0);

    spy.mockRestore();
  });
});
