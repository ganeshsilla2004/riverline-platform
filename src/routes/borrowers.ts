import { Router } from "express";
import { randomUUID } from "node:crypto";
import { handler } from "./_helpers.js";
import { authorize } from "../rbac/policy.js";
import { scopeBorrowerFilter } from "../rbac/scope.js";
import { tenant } from "../db/tenant.js";
import { tokenize } from "../pii/tokenizer.js";
import { borrowerPiiFields } from "../pii/fields.js";
import { maskBorrower } from "../rbac/masking.js";
import { currentContext } from "../db/context.js";
import { Errors } from "../lib/errors.js";

export const borrowersRouter = Router();

borrowersRouter.get("/", handler(async (req, _res, tenantId) => {
  authorize("borrower:read");
  const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10), 200);
  const filter = scopeBorrowerFilter({});
  const docs = await (await tenant.borrowers(tenantId)).find(filter).limit(limit).toArray();
  const ctx = currentContext();
  return {
    count: docs.length,
    borrowers: await Promise.all(docs.map((d) => maskBorrower(tenantId, ctx.role, d))),
  };
}));

borrowersRouter.get("/:id", handler(async (req, _res, tenantId) => {
  authorize("borrower:read");
  const filter = scopeBorrowerFilter({ borrowerId: req.params.id });
  const doc = await (await tenant.borrowers(tenantId)).findOne(filter);
  if (!doc) throw Errors.notFound();
  const ctx = currentContext();
  return { borrower: await maskBorrower(tenantId, ctx.role, doc) };
}));

borrowersRouter.post("/", handler(async (req, res, tenantId) => {
  authorize("borrower:create");
  const body = req.body ?? {};
  for (const f of ["firstName", "lastName", "phone", "email", "aadhaar", "pan", "bankAccount"] as const) {
    if (typeof body[f] !== "string") throw Errors.badRequest(`missing field: ${f}`);
  }
  const id = randomUUID();
  const tokens: Record<string, string> = {};
  for (const f of borrowerPiiFields) {
    const raw = f.name === "fullName" ? `${body.firstName} ${body.lastName}` : (body as Record<string, string>)[f.name];
    tokens[f.name] = await tokenize(tenantId, f.type, raw);
  }
  const now = new Date();
  const ctx = currentContext();
  const doc = {
    _id: id,
    borrowerId: id,
    firstName: tokens.firstName,
    lastName: tokens.lastName,
    fullName: tokens.fullName,
    phone: tokens.phone,
    email: tokens.email,
    aadhaar: tokens.aadhaar,
    pan: tokens.pan,
    bankAccount: tokens.bankAccount,
    assignedTo: typeof body.assignedTo === "string" ? body.assignedTo : ctx.userId,
    status: "active",
    dpdBucket: typeof body.dpdBucket === "string" ? body.dpdBucket : "0-30",
    outstandingAmount: Number(body.outstandingAmount ?? 0),
    posAmount: Number(body.posAmount ?? 0),
    tosAmount: Number(body.tosAmount ?? 0),
    settlementFloor: Number(body.settlementFloor ?? 0),
    loanType: typeof body.loanType === "string" ? body.loanType : "personal",
    language: typeof body.language === "string" ? body.language : "en",
    city: typeof body.city === "string" ? body.city : "",
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    notes: typeof body.notes === "string" ? body.notes : "",
  };
  await (await tenant.borrowers(tenantId)).insertOne(doc);
  res.status(201);
  return { borrower: await maskBorrower(tenantId, ctx.role, doc) };
}));

borrowersRouter.put("/:id", handler(async (req, _res, tenantId) => {
  authorize("borrower:update");
  const body = req.body ?? {};
  const filter = scopeBorrowerFilter({ borrowerId: req.params.id });

  const update: Record<string, unknown> = { updatedAt: new Date() };
  const tokenFields = ["firstName", "lastName", "phone", "email", "aadhaar", "pan", "bankAccount"] as const;
  for (const f of tokenFields) {
    if (typeof body[f] === "string") {
      const type = borrowerPiiFields.find((x) => x.name === f)?.type;
      if (!type) continue;
      update[f] = await tokenize(tenantId, type, body[f]);
    }
  }
  if (typeof body.firstName === "string" || typeof body.lastName === "string") {
    const existing = await (await tenant.borrowers(tenantId)).findOne(filter);
    if (existing) {
      const fn = (update.firstName as string | undefined) ?? existing.firstName;
      const ln = (update.lastName as string | undefined) ?? existing.lastName;
      // Re-tokenize the *raw* full name from inputs if both provided; otherwise leave fullName alone.
      if (typeof body.firstName === "string" && typeof body.lastName === "string") {
        update.fullName = await tokenize(tenantId, "name", `${body.firstName} ${body.lastName}`);
      } else {
        // Keep fullName token consistent: detokenize+retokenize is overkill; leave existing.
        update.fullName = existing.fullName;
        void fn; void ln;
      }
    }
  }
  for (const f of ["status", "dpdBucket", "notes", "city", "language", "assignedTo"] as const) {
    if (body[f] !== undefined) update[f] = body[f];
  }
  for (const f of ["outstandingAmount", "posAmount", "tosAmount", "settlementFloor"] as const) {
    if (body[f] !== undefined) update[f] = Number(body[f]);
  }

  const result = await (await tenant.borrowers(tenantId)).findOneAndUpdate(
    filter,
    { $set: update },
    { returnDocument: "after" },
  );
  if (!result) throw Errors.notFound();
  const ctx = currentContext();
  return { borrower: await maskBorrower(tenantId, ctx.role, result) };
}));
