import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { Role } from "../db/context.js";

export interface JwtClaims {
  sub: string;       // userId
  role: Role;
  tenantId: string;  // user's home tenant (may not be the resource's tenant for admins/engineers)
  jti: string;
  iat: number;
  exp: number;
}

export const signToken = (payload: { userId: string; role: Role; tenantId: string }): string => {
  const claims: Omit<JwtClaims, "iat" | "exp"> = {
    sub: payload.userId,
    role: payload.role,
    tenantId: payload.tenantId,
    jti: randomUUID(),
  };
  return jwt.sign(claims, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: config.jwtExpirySeconds,
  });
};

export const verifyToken = (token: string): JwtClaims => {
  const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
  if (typeof decoded === "string") throw new Error("Unexpected JWT shape");
  return decoded as JwtClaims;
};
