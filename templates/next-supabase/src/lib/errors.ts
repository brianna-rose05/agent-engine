/**
 * Every rule a server function enforces fails with an AppError. `message` is shown to the user, so keep
 * it short and friendly; `code` is stable so pages and tests can tell errors apart.
 */
export type ErrorCode = "not_found" | "forbidden" | "invalid" | "conflict" | "unauthenticated";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
