import type { Request, Response, NextFunction } from "express";
import { currentContext, withActiveTenant } from "../db/context.js";
import { isMultiTenantRole, isSingleTenantRole } from "../rbac/roles.js";
import { writeAudit, revokeSession } from "../audit/logger.js";
import { Errors } from "../lib/errors.js";
import { overallMaskingLevel } from "../rbac/masking.js";
import { catalog } from "../db/catalog.js";

// Resolves the effective tenant for a request and detects cross-tenant attempts.
//
// For multi-tenant roles (admin, engineer):
//   - requested tenant comes from `?tenantId=...`. If absent, falls back to
//     the user's JWT home tenant (still a valid tenant).
//
// For single-tenant roles (debt-counselor, client-viewer):
//   - if `?tenantId=...` is provided and differs from JWT.tenantId,
//     this is a breach attempt — revoke jti, write security audit, 403.
//   - otherwise use JWT.tenantId.
export const resolveTenant = async (req: Request): Promise<string> => {
  const ctx = currentContext();
  const requested = (req.query.tenantId as string | undefined)?.trim();

  if (isSingleTenantRole(ctx.role)) {
    if (requested && requested !== ctx.tenantId) {
      await writeAudit({
        tenantId: requested,
        method: req.method,
        pathTemplate: req.route?.path ?? req.path,
        resourceIds: collectResourceIds(req),
        maskingLevel: "masked",
        outcome: { statusCode: 403, success: false, reason: "cross-tenant attempt" },
        securityIncident: true,
      });
      await revokeSession(ctx.jti, ctx.userId, `cross-tenant: tenantId=${requested}`);
      throw Errors.forbidden("forbidden");
    }
    return ctx.tenantId as string;
  }

  // Multi-tenant role — validate target tenant exists if specified
  if (requested) {
    const exists = await (await catalog.tenants()).findOne({ clientId: requested });
    if (!exists) throw Errors.notFound();
    return requested;
  }
  return ctx.tenantId as string;
};

export const collectResourceIds = (req: Request): string[] => {
  const ids: string[] = [];
  for (const v of Object.values(req.params)) {
    if (typeof v === "string" && v.length > 0) ids.push(v);
  }
  return ids;
};

// Wrap an async handler so it runs inside the resolved tenant's DB context
// and emits an audit entry on success. Failures are audited at the global
// error middleware. The handler MUST return a JSON-serializable value.
export const handler = (
  fn: (req: Request, res: Response, tenantId: string) => Promise<unknown>,
) => async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const tenantId = await resolveTenant(req);
    await withActiveTenant(tenantId, async () => {
      const result = await fn(req, res, tenantId);
      if (!res.headersSent) {
        res.json(result);
      }
      const ctx = currentContext();
      await writeAudit({
        tenantId,
        method: req.method,
        pathTemplate: req.route?.path ?? req.path,
        resourceIds: collectResourceIds(req),
        maskingLevel: overallMaskingLevel(ctx.role),
        outcome: { statusCode: res.statusCode, success: true },
      });
    });
  } catch (err) {
    next(err);
  }
};
