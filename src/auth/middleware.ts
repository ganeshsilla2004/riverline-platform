import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "./jwt.js";
import { Errors } from "../lib/errors.js";
import { catalog } from "../db/catalog.js";
import { runInContext, type TenantContext } from "../db/context.js";

declare module "express-serve-static-core" {
  interface Request {
    ctx?: TenantContext;
  }
}

export const requireAuth = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const auth = req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m) return next(Errors.unauthorized());
    const claims = verifyToken(m[1]);

    const revoked = await (await catalog.revokedSessions()).findOne({ _id: claims.jti });
    if (revoked) return next(Errors.unauthorized());

    const ctx: TenantContext = {
      userId: claims.sub,
      role: claims.role,
      tenantId: claims.tenantId,
      jti: claims.jti,
    };
    req.ctx = ctx;
    runInContext(ctx, () => next());
  } catch (err) {
    next(Errors.unauthorized());
  }
};

// Allows /health and /webhooks/payment-gateway through without auth.
export const allowAnonymous = (req: Request, _res: Response, next: NextFunction): void => {
  next();
};
