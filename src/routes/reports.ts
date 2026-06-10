import { Router } from "express";
import { randomUUID } from "node:crypto";
import { handler } from "./_helpers.js";
import { authorize } from "../rbac/policy.js";
import { tenant } from "../db/tenant.js";
import { getComplianceQueue } from "../jobs/queue.js";
import { currentContext } from "../db/context.js";

export const reportsRouter = Router();

reportsRouter.post("/compliance", handler(async (_req, res, tenantId) => {
  authorize("report:request");
  const ctx = currentContext();
  const reportId = randomUUID();
  const now = new Date();
  await (await tenant.reports(tenantId)).insertOne({
    _id: reportId,
    jobId: reportId,
    tenantId,
    requestedBy: ctx.userId,
    requestedAt: now,
    status: "queued",
  });
  await getComplianceQueue().add(
    "generate",
    {
      tenantId,
      requestedBy: ctx.userId,
      reportId,
      requestedAt: now.toISOString(),
    },
    { jobId: reportId, removeOnComplete: 100, removeOnFail: 50 },
  );
  res.status(202);
  return { jobId: reportId, status: "queued" };
}));

reportsRouter.get("/compliance", handler(async (_req, _res, tenantId) => {
  authorize("report:read");
  const docs = await (await tenant.reports(tenantId))
    .find({})
    .sort({ requestedAt: -1 })
    .limit(10)
    .toArray();
  return { count: docs.length, reports: docs };
}));
