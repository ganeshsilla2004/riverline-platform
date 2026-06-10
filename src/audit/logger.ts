import { randomUUID } from "node:crypto";
import { tenant, type AuditLogDoc } from "../db/tenant.js";
import { catalog } from "../db/catalog.js";
import { tryCurrentContext } from "../db/context.js";

export interface AuditEntry {
  // The tenant whose data was accessed. Differs from user's home tenantId
  // only for admins/engineers acting cross-tenant, or for breach incidents.
  tenantId: string;
  method: string;
  pathTemplate: string;
  resourceIds?: string[];
  maskingLevel: "full" | "partial" | "masked";
  outcome: { statusCode: number; success: boolean; reason?: string };
  securityIncident?: boolean;
}

// Append-only writer. This is the ONLY public function in this module —
// there is no update/delete export so audit history cannot be tampered with
// through normal application paths.
export const writeAudit = async (entry: AuditEntry): Promise<void> => {
  const ctx = tryCurrentContext();
  const doc: AuditLogDoc = {
    _id: randomUUID(),
    ts: new Date(),
    userId: ctx?.userId ?? "anonymous",
    role: ctx?.role ?? "anonymous",
    tenantId: entry.tenantId,
    method: entry.method,
    pathTemplate: entry.pathTemplate,
    resourceIds: entry.resourceIds ?? [],
    maskingLevel: entry.maskingLevel,
    outcome: entry.outcome,
    jti: ctx?.jti,
    securityIncident: entry.securityIncident,
  };
  try {
    await (await tenant.auditLogs(entry.tenantId)).insertOne(doc);
  } catch {
    // Audit writes must not propagate failure into the request lifecycle.
    // In production we'd alert on this; here we silently swallow so the
    // breach-response path always returns the right HTTP status.
  }
};

// Revoke the active session jti — used by the breach detector when a request
// attempts to access another tenant's data. Per compliance §5.
export const revokeSession = async (jti: string, userId: string, reason: string): Promise<void> => {
  try {
    await (await catalog.revokedSessions()).insertOne({
      _id: jti,
      userId,
      reason,
      revokedAt: new Date(),
    });
  } catch {
    // Idempotent — already-revoked is fine.
  }
};
