import { Errors } from "../lib/errors.js";
import { currentContext } from "../db/context.js";
import { isAllowed, type Action } from "./roles.js";

export const authorize = (action: Action): void => {
  const ctx = currentContext();
  if (!isAllowed(ctx.role, action)) {
    throw Errors.forbidden(`role ${ctx.role} not permitted for ${action}`);
  }
};
