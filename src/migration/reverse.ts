import { getClient, closeClient } from "../db/client.js";
import { catalog } from "../db/catalog.js";
import { tenant } from "../db/tenant.js";
import { vault } from "../db/vault.js";
import { config } from "../config.js";
import { clearKeyCache } from "../pii/tokenizer.js";

// Drop every tenant data DB and vault DB, then clear the catalog.
// Safe to run repeatedly; safe to run before migrate to reset state.
export const reverseMigration = async (opts: { silent?: boolean } = {}): Promise<void> => {
  const log = (m: string): void => { if (!opts.silent) console.log(m); };
  const client = await getClient();
  const tenants = await (await catalog.tenants()).find({}).toArray();
  for (const t of tenants) {
    await client.db(tenant.dbName(t.clientId)).dropDatabase();
    await client.db(vault.dbName(t.clientId)).dropDatabase();
    log(`reverse: dropped tenant + vault DB for ${t.clientId}`);
  }
  await client.db(config.catalogDbName).dropDatabase();
  log(`reverse: dropped catalog`);
  clearKeyCache();
};

const isMain = process.argv[1]?.endsWith("reverse.ts") || process.argv[1]?.endsWith("reverse.js");
if (isMain) {
  reverseMigration().then(() => closeClient()).then(() => process.exit(0))
    .catch((err) => {
      console.error("reverse failed:", err);
      process.exit(1);
    });
}
