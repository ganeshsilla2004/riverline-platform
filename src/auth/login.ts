import type { Request, Response } from "express";
import { catalog } from "../db/catalog.js";
import { verifyPassword } from "./password.js";
import { signToken } from "./jwt.js";
import { Errors } from "../lib/errors.js";

export const loginHandler = async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string") {
    throw Errors.badRequest("email and password required");
  }
  const user = await (await catalog.users()).findOne({ email: email.toLowerCase() });
  if (!user || user.status !== "active") {
    throw Errors.unauthorized();
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw Errors.unauthorized();
  }
  const token = signToken({
    userId: user.userId,
    role: user.role,
    tenantId: user.clientId,
  });
  res.json({
    token,
    user: {
      userId: user.userId,
      email: user.email,
      role: user.role,
      tenantId: user.clientId,
    },
  });
};
