import type { Collection, Db } from "mongodb";
import { getClient } from "./client.js";
import { config } from "../config.js";
import type { Role } from "./context.js";
import type { WrappedKey } from "../lib/crypto.js";

export interface TenantDoc {
  _id: string;
  clientId: string;
  name: string;
  type: string;
  status: string;
  region?: string;
  contactEmail?: string;
  onboardedAt: Date;
}

export interface UserDoc {
  _id: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  // Home tenant. admins and engineers have null (multi-tenant scope).
  // In the seed data admins/engineers are bound to a clientId, but their
  // role permits cross-tenant access. We honor the role, not the field.
  clientId: string;
  status: string;
  passwordHash: string;
  createdAt: Date;
}

export interface TenantKeyDoc {
  _id: string; // clientId
  wrappedKey: WrappedKey;
  createdAt: Date;
}

export interface RevokedSessionDoc {
  _id: string; // jti
  userId: string;
  reason: string;
  revokedAt: Date;
}

const catalogDb = async (): Promise<Db> => (await getClient()).db(config.catalogDbName);

export const catalog = {
  tenants: async (): Promise<Collection<TenantDoc>> =>
    (await catalogDb()).collection<TenantDoc>("tenants"),
  users: async (): Promise<Collection<UserDoc>> =>
    (await catalogDb()).collection<UserDoc>("users"),
  tenantKeys: async (): Promise<Collection<TenantKeyDoc>> =>
    (await catalogDb()).collection<TenantKeyDoc>("tenant_keys"),
  revokedSessions: async (): Promise<Collection<RevokedSessionDoc>> =>
    (await catalogDb()).collection<RevokedSessionDoc>("revoked_sessions"),
};

export const ensureCatalogIndexes = async (): Promise<void> => {
  const users = await catalog.users();
  await users.createIndex({ email: 1 }, { unique: true });
  const tenants = await catalog.tenants();
  await tenants.createIndex({ clientId: 1 }, { unique: true });
};
