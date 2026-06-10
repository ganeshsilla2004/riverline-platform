import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "./auth/middleware.js";
import { loginHandler } from "./auth/login.js";
import { healthRouter } from "./routes/health.js";
import { borrowersRouter } from "./routes/borrowers.js";
import { conversationsRouter } from "./routes/conversations.js";
import { paymentsRouter } from "./routes/payments.js";
import { reportsRouter } from "./routes/reports.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { auditRouter } from "./routes/audit.js";
import { AppError, Errors } from "./lib/errors.js";
import { writeAudit } from "./audit/logger.js";
import { tryCurrentContext } from "./db/context.js";
import { overallMaskingLevel } from "./rbac/masking.js";

const captureRawBody = (req: Request, _res: Response, buf: Buffer): void => {
  (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
};

const asyncWrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

export const buildApp = () => {
  const app = express();
  app.use(express.json({ verify: captureRawBody, limit: "1mb" }));

  app.use("/health", healthRouter);
  app.use("/webhooks", webhooksRouter);
  app.post("/auth/login", asyncWrap(loginHandler));

  app.use(requireAuth);

  app.use("/borrowers", borrowersRouter);
  app.use("/conversations", conversationsRouter);
  app.use("/payments", paymentsRouter);
  app.use("/reports", reportsRouter);
  app.use("/audit-logs", auditRouter);

  app.use((_req, _res, next) => next(Errors.notFound()));

  const errorHandler: ErrorRequestHandler = async (err, req, res, _next) => {
    const isApp = err instanceof AppError;
    const status = isApp ? err.status : 500;
    const body = { error: isApp ? err.publicMessage : "internal error" };

    // Audit the failure with the same detail as a successful call.
    try {
      const ctx = tryCurrentContext();
      const requestedTenant = (req.query?.tenantId as string | undefined) || ctx?.tenantId || "unknown";
      await writeAudit({
        tenantId: requestedTenant,
        method: req.method,
        pathTemplate: req.route?.path ?? req.path,
        resourceIds: Object.values(req.params).filter((v): v is string => typeof v === "string"),
        maskingLevel: ctx ? overallMaskingLevel(ctx.role) : "masked",
        outcome: { statusCode: status, success: false, reason: isApp ? err.code : "internal" },
      });
    } catch {}

    res.status(status).json(body);
  };
  app.use(errorHandler);

  return app;
};
