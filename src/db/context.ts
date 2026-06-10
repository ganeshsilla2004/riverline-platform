import { AsyncLocalStorage } from "node:async_hooks";

export type Role = "admin" | "debt-counselor" | "engineer" | "client-viewer";

export interface TenantContext {
  userId: string;
  role: Role;
  // null = admin/engineer roles operating across tenants
  tenantId: string | null;
  jti: string;
  // When set, the resolved tenant for the current request resource.
  // Used so handlers and DB accessors always hit the *resource's* DB,
  // while role-based checks compare against the JWT's home tenantId above.
  activeTenantId?: string;
}

const store = new AsyncLocalStorage<TenantContext>();

export const runInContext = <T>(ctx: TenantContext, fn: () => T | Promise<T>): T | Promise<T> =>
  store.run(ctx, fn);

export const currentContext = (): TenantContext => {
  const ctx = store.getStore();
  if (!ctx) throw new Error("No tenant context active");
  return ctx;
};

export const tryCurrentContext = (): TenantContext | undefined => store.getStore();

// Use when a route/job/webhook needs to switch the active tenant DB target
// without losing the authenticated user identity.
export const withActiveTenant = <T>(tenantId: string, fn: () => T | Promise<T>): T | Promise<T> => {
  const ctx = currentContext();
  return store.run({ ...ctx, activeTenantId: tenantId }, fn);
};
