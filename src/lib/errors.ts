export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly publicMessage: string = message,
  ) {
    super(message);
  }
}

export const Errors = {
  unauthorized: () => new AppError(401, "UNAUTHORIZED", "unauthorized", "unauthorized"),
  forbidden: (reason = "forbidden") => new AppError(403, "FORBIDDEN", reason, "forbidden"),
  notFound: () => new AppError(404, "NOT_FOUND", "not found", "not found"),
  badRequest: (msg: string) => new AppError(400, "BAD_REQUEST", msg, msg),
  conflict: (msg: string) => new AppError(409, "CONFLICT", msg, msg),
  unavailable: () => new AppError(503, "UNAVAILABLE", "service temporarily unavailable", "service temporarily unavailable"),
  internal: () => new AppError(500, "INTERNAL", "internal error", "internal error"),
};
