import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { migrate } from "../src/migration/seed.js";
import { reverseMigration } from "../src/migration/reverse.js";
import { getClient, closeClient } from "../src/db/client.js";
import { catalog } from "../src/db/catalog.js";
import { tenant } from "../src/db/tenant.js";
import { vault } from "../src/db/vault.js";
import { runInContext } from "../src/db/context.js";

const readSeed = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(`./seed-data/${name}`, "utf8")) as T;

describe("migration", () => {
  beforeAll(async () => {
    await reverseMigration({ silent: true });
  }, 60_000);
  afterAll(async () => { await closeClient(); });

  let migrateResult: Awaited<ReturnType<typeof migrate>>;

  it("ingests all seed records in under 60 seconds", async () => {
    migrateResult = await migrate({ silent: true });
    expect(migrateResult.skipped).toBe(false);
    expect(migrateResult.durationMs).toBeLessThan(60_000);
  }, 60_000);

  it("ingest accounts for every record — valid + orphaned == source count", async () => {
    interface Tenanted { clientId?: string | null }
    const [clientsSeed, borrowersSeed, paymentsSeed] = await Promise.all([
      readSeed<Tenanted[]>("clients.json"),
      readSeed<Tenanted[]>("borrowers.json"),
      readSeed<Tenanted[]>("payments.json"),
    ]);
    expect(await (await catalog.tenants()).countDocuments()).toBe(clientsSeed.length);

    let totalBorrowers = 0;
    let totalPayments = 0;
    const cs = await (await catalog.tenants()).find({}).toArray();
    for (const c of cs) {
      const ctx = {
        userId: "x", role: "admin" as const, tenantId: c.clientId,
        jti: "x", activeTenantId: c.clientId,
      };
      totalBorrowers += await runInContext(ctx, async () =>
        (await tenant.borrowers(c.clientId)).countDocuments()
      );
      totalPayments += await runInContext(ctx, async () =>
        (await tenant.payments(c.clientId)).countDocuments()
      );
    }
    // Per spec §3.5 — no silent drops. Valid + orphans must equal source.
    expect(totalBorrowers + migrateResult.orphans.borrowers).toBe(borrowersSeed.length);
    expect(totalPayments + migrateResult.orphans.payments).toBe(paymentsSeed.length);
    // Confirm we actually detected the data-quality issues, not buried them.
    expect(migrateResult.orphans.borrowers).toBeGreaterThan(0);
  });

  it("re-running migrate is idempotent (skip after first)", async () => {
    const second = await migrate({ silent: true });
    expect(second.skipped).toBe(true);
  });

  it("vault is populated and physically separate from tenant DB", async () => {
    const client = await getClient();
    const dbs = await client.db("admin").admin().listDatabases();
    const names = dbs.databases.map((d) => d.name);
    expect(names).toContain("tenant_client_sunrise_001");
    expect(names).toContain("vault_client_sunrise_001");

    const ctx = {
      userId: "x", role: "admin" as const, tenantId: "client_sunrise_001",
      jti: "x", activeTenantId: "client_sunrise_001",
    };
    const tokenCount = await runInContext(ctx, async () =>
      (await vault.tokens("client_sunrise_001")).countDocuments()
    );
    expect(tokenCount).toBeGreaterThan(0);
  });

  it("reverse migration drops every tenant + vault DB and the catalog", async () => {
    await reverseMigration({ silent: true });
    const client = await getClient();
    const dbs = await client.db("admin").admin().listDatabases();
    const names = dbs.databases.map((d) => d.name);
    expect(names).not.toContain("tenant_client_sunrise_001");
    expect(names).not.toContain("vault_client_sunrise_001");
    expect(names).not.toContain("platform_catalog");
  });
});
