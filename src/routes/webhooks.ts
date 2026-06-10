import { Router, type Request, type Response } from "express";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { runInContext, type TenantContext } from "../db/context.js";
import { catalog } from "../db/catalog.js";
import { tenant } from "../db/tenant.js";
import { writeAudit } from "../audit/logger.js";
import { config } from "../config.js";
import { Errors } from "../lib/errors.js";

export const webhooksRouter = Router();

const verifySignature = (rawBody: string, signature: string): boolean => {
  const expected = createHmac("sha256", config.webhookSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

webhooksRouter.post("/payment-gateway", async (req: Request, res: Response) => {
  try {
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    const sig = req.header("x-webhook-signature") ?? "";
    if (!sig || !verifySignature(rawBody, sig)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    const { reference, gatewayReference, amount, borrowerId, status } = req.body ?? {};
    if (typeof reference !== "string" || typeof gatewayReference !== "string" ||
        typeof amount !== "number" || typeof borrowerId !== "string") {
      res.status(400).json({ error: "missing required fields" });
      return;
    }

    // Tenant identity comes from the reference, not auth. Reference format:
    //   PAY-<clientId-prefix-8-chars>-<uuid-8>
    // We resolve the prefix to a real tenant via the catalog.
    const m = /^PAY-([A-Za-z0-9_]+)-/.exec(reference);
    if (!m) {
      res.status(400).json({ error: "malformed reference" });
      return;
    }
    const prefix = m[1];
    const t = await (await catalog.tenants()).findOne({ clientId: { $regex: `^${prefix}` } });
    if (!t) {
      res.status(404).json({ error: "unknown tenant" });
      return;
    }

    // Synthetic context for the webhook — no human user, system-level.
    const ctx: TenantContext = {
      userId: "system:webhook",
      role: "admin",
      tenantId: t.clientId,
      jti: `webhook:${randomUUID()}`,
      activeTenantId: t.clientId,
    };

    await runInContext(ctx, async () => {
      const payments = await tenant.payments(t.clientId);
      const existing = await payments.findOne({ reference });
      if (existing) {
        // Idempotent — just update status.
        await payments.updateOne({ _id: existing._id }, {
          $set: {
            status: typeof status === "string" ? status : existing.status,
            gatewayReference,
          },
        });
      } else {
        const id = randomUUID();
        await payments.insertOne({
          _id: id,
          paymentId: id,
          borrowerId,
          amount,
          currency: "INR",
          method: "webhook",
          status: typeof status === "string" ? status : "completed",
          reference,
          gatewayReference,
          channel: "webhook",
          paidAt: new Date(),
          createdAt: new Date(),
        });
      }
      await writeAudit({
        tenantId: t.clientId,
        method: "POST",
        pathTemplate: "/webhooks/payment-gateway",
        resourceIds: [borrowerId],
        maskingLevel: "masked",
        outcome: { statusCode: 200, success: true },
      });
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "internal error" });
  }
});

void Errors;
