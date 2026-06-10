import { Router } from "express";
import { randomUUID } from "node:crypto";
import { handler } from "./_helpers.js";
import { authorize } from "../rbac/policy.js";
import { scopeBorrowerFilter } from "../rbac/scope.js";
import { tenant } from "../db/tenant.js";
import { tokenizePhonesInText } from "../pii/tokenizer.js";
import { currentContext } from "../db/context.js";
import { Errors } from "../lib/errors.js";
import { config } from "../config.js";

export const conversationsRouter = Router();

const ensureBorrowerInScope = async (tenantId: string, borrowerId: string): Promise<void> => {
  const filter = scopeBorrowerFilter({ borrowerId });
  const exists = await (await tenant.borrowers(tenantId)).findOne(filter, { projection: { _id: 1 } });
  if (!exists) throw Errors.notFound();
};

conversationsRouter.get("/:borrowerId", handler(async (req, _res, tenantId) => {
  authorize("conversation:read");
  await ensureBorrowerInScope(tenantId, req.params.borrowerId);
  const docs = await (await tenant.conversations(tenantId))
    .find({ borrowerId: req.params.borrowerId })
    .toArray();
  return { count: docs.length, conversations: docs };
}));

const hourInIST = (d: Date): number => {
  // IST offset is +05:30 from UTC, no DST.
  const utc = d.getTime();
  const istMs = utc + (5 * 60 + 30) * 60 * 1000;
  return new Date(istMs).getUTCHours();
};

const isQuietHourIST = (d: Date): boolean => {
  const h = hourInIST(d);
  // 8 PM (20) to 8 AM (8) — inclusive at 20, exclusive at 8.
  return h >= config.quietHoursStartIST || h < config.quietHoursEndIST;
};

conversationsRouter.post("/:borrowerId/messages", handler(async (req, res, tenantId) => {
  authorize("conversation:send");
  await ensureBorrowerInScope(tenantId, req.params.borrowerId);
  const { text, channel } = req.body ?? {};
  if (typeof text !== "string" || !text.trim()) throw Errors.badRequest("text required");

  const now = new Date();
  if (isQuietHourIST(now)) {
    throw Errors.forbidden("quiet hours: outbound messages not permitted between 20:00 and 08:00 IST");
  }

  const scrubbed = await tokenizePhonesInText(tenantId, text);
  const message = {
    sender: "agent" as const,
    text: scrubbed,
    timestamp: now,
  };

  const conv = await (await tenant.conversations(tenantId)).findOne({ borrowerId: req.params.borrowerId });
  if (conv) {
    await (await tenant.conversations(tenantId)).updateOne(
      { _id: conv._id },
      { $push: { messages: message }, $set: { updatedAt: now } },
    );
  } else {
    const id = randomUUID();
    await (await tenant.conversations(tenantId)).insertOne({
      _id: id,
      conversationId: id,
      borrowerId: req.params.borrowerId,
      channel: typeof channel === "string" ? channel : "whatsapp",
      status: "ongoing",
      messages: [message],
      createdAt: now,
      updatedAt: now,
    });
  }
  void currentContext();
  res.status(201);
  return { ok: true };
}));
