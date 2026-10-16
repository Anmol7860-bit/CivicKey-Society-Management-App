export type ErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'USER_INACTIVE'
  | 'ROLE_MISMATCH'
  | 'INVALID_REFRESH_TOKEN'
  | 'SESSION_EXPIRED'
  | 'TOKEN_MISSING'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'VALIDATION_ERROR'
  | 'TOO_MANY_REQUESTS'
  | 'PERMISSION_DENIED'
  | 'CROSS_SOCIETY_ACCESS'
  | 'NOT_YOUR_FLAT'
  | 'ROLE_NOT_ASSIGNED'
  | 'INVALID_STATE'
  | 'COMMITTEE_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
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
