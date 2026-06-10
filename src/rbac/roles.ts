import type { Role } from "../db/context.js";

export type Action =
  | "borrower:create"
  | "borrower:read"
  | "borrower:update"
  | "conversation:read"
  | "conversation:send"
  | "payment:create"
  | "payment:read"
  | "report:request"
  | "report:read"
  | "audit:read";

// Deny by default. Only roles listed here for an action are permitted.
const matrix: Record<Action, Role[]> = {
  "borrower:create": ["admin"],
  "borrower:read": ["admin", "debt-counselor", "engineer", "client-viewer"],
  "borrower:update": ["admin", "debt-counselor"],
  "conversation:read": ["admin", "debt-counselor", "engineer", "client-viewer"],
  "conversation:send": ["admin", "debt-counselor"],
  "payment:create": ["admin", "debt-counselor"],
  "payment:read": ["admin", "debt-counselor", "engineer", "client-viewer"],
  "report:request": ["admin", "client-viewer"],
  "report:read": ["admin", "engineer", "client-viewer"],
  "audit:read": ["admin", "engineer"],
};

export const isAllowed = (role: Role, action: Action): boolean =>
  matrix[action]?.includes(role) ?? false;

// Roles whose authority spans every tenant. The home-tenant on the JWT
// is informational for these — cross-tenant requests are NOT a breach.
export const isMultiTenantRole = (role: Role): boolean =>
  role === "admin" || role === "engineer";

// Roles confined to their JWT's home tenant. Any deviation = breach.
export const isSingleTenantRole = (role: Role): boolean => !isMultiTenantRole(role);
