import { Router } from "express";
import { randomUUID } from "node:crypto";
import { handler } from "./_helpers.js";
import { authorize } from "../rbac/policy.js";
import { scopeBorrowerFilter } from "../rbac/scope.js";
import { tenant } from "../db/tenant.js";
import { Errors } from "../lib/errors.js";

export const paymentsRouter = Router();

paymentsRouter.post("/", handler(async (req, res, tenantId) => {
  authorize("payment:create");
  const { borrowerId, amount, currency, method, channel, gatewayReference } = req.body ?? {};
  if (typeof borrowerId !== "string" || typeof amount !== "number") {
    throw Errors.badRequest("borrowerId and amount required");
  }
  const exists = await (await tenant.borrowers(tenantId)).findOne(
    scopeBorrowerFilter({ borrowerId }),
    { projection: { _id: 1 } },
  );
  if (!exists) throw Errors.notFound();

  const id = randomUUID();
  const doc = {
    _id: id,
    paymentId: id,
    borrowerId,
    amount,
    currency: typeof currency === "string" ? currency : "INR",
    method: typeof method === "string" ? method : "upi",
    status: "completed",
    reference: `PAY-${tenantId.slice(0, 8)}-${id.slice(0, 8)}`,
    gatewayReference: typeof gatewayReference === "string" ? gatewayReference : `GW-${id.slice(0, 12)}`,
    channel: typeof channel === "string" ? channel : "payment_link",
    paidAt: new Date(),
    createdAt: new Date(),
  };
  await (await tenant.payments(tenantId)).insertOne(doc);
  res.status(201);
  return { payment: doc };
}));

paymentsRouter.get("/:borrowerId", handler(async (req, _res, tenantId) => {
  authorize("payment:read");
  // Scope check: only return payments for borrowers the caller is allowed to see.
  const allowed = await (await tenant.borrowers(tenantId)).findOne(
    scopeBorrowerFilter({ borrowerId: req.params.borrowerId }),
    { projection: { _id: 1 } },
  );
  if (!allowed) throw Errors.notFound();
  const docs = await (await tenant.payments(tenantId))
    .find({ borrowerId: req.params.borrowerId })
    .sort({ paidAt: -1 })
    .toArray();
  return { count: docs.length, payments: docs };
}));
