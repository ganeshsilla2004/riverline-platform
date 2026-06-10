import type { Collection, Db } from "mongodb";
import { getClient } from "./client.js";
import { config } from "../config.js";
import { currentContext } from "./context.js";

export interface VaultTokenDoc {
  _id: string; // token
  fieldType: string;
  value: string;
  createdAt: Date;
}

const vaultDbName = (tenantId: string): string => `${config.vaultDbPrefix}${tenantId}`;

const vaultDb = async (tenantId?: string): Promise<Db> => {
  const t = tenantId ?? currentContext().activeTenantId ?? currentContext().tenantId;
  if (!t) throw new Error("Cannot resolve vault DB: no tenant in context");
  return (await getClient()).db(vaultDbName(t));
};

export const vault = {
  dbName: vaultDbName,
  tokens: async (tenantId?: string): Promise<Collection<VaultTokenDoc>> =>
    (await vaultDb(tenantId)).collection<VaultTokenDoc>("tokens"),
};

export const ensureVaultIndexes = async (tenantId: string): Promise<void> => {
  const c = await vault.tokens(tenantId);
  await c.createIndex({ _id: 1, fieldType: 1 });
};
