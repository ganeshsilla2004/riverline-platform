import { Router } from "express";
import { handler } from "./_helpers.js";
import { authorize } from "../rbac/policy.js";
import { tenant } from "../db/tenant.js";

export const auditRouter = Router();

auditRouter.get("/", handler(async (req, _res, tenantId) => {
  authorize("audit:read");
  const limit = Math.min(parseInt((req.query.limit as string) ?? "100", 10), 500);
  const docs = await (await tenant.auditLogs(tenantId))
    .find({})
    .sort({ ts: -1 })
    .limit(limit)
    .toArray();
  return { count: docs.length, auditLogs: docs };
}));
