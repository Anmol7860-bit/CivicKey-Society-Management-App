export type ErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'USER_INACTIVE'
  | 'INVALID_REFRESH_TOKEN'
  | 'SESSION_EXPIRED'
  | 'VALIDATION_ERROR'
  | 'TOO_MANY_REQUESTS'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'

interface AppErrorOptions {
  details?: unknown
  retryAfterSeconds?: number
}

/**
 * An expected failure with a stable code. Rendered by the error handler as:
 * { error: { code, message, details?, retryAfterSeconds? } }
 */
export class AppError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly details?: unknown
  readonly retryAfterSeconds?: number

  constructor(status: number, code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = options.details
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}
