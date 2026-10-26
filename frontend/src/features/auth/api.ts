import type { LoginFormValues } from './components/LoginForm'

export type Role = 'RESIDENT' | 'GUARD' | 'ADMIN'

export type Permission =
  | 'SOCIETY_MANAGE' | 'USER_MANAGE' | 'GUARD_MANAGE' | 'STAFF_MANAGE' | 'AUDIT_VIEW'
  | 'BILLING_RATE_SET' | 'INVOICE_GENERATE' | 'PAYMENT_CASH_MARK' | 'REPORT_VIEW'
  | 'VISIT_REGISTER' | 'VISIT_DECIDE' | 'VISIT_ENTRY_RECORD' | 'VISIT_EXIT' | 'PASS_VALIDATE'
  | 'VISITOR_APPROVE' | 'VISITOR_PASS_CREATE' | 'VISIT_VIEW_OWN' | 'BILL_VIEW_OWN' | 'BILL_PAY' | 'RECEIPT_VIEW_OWN'

export interface AuthUser {
  id: string
  name: string
  phone: string | null
  email: string | null
  role: Role
  societyId: string | null
  /** Decides what the UI shows; the backend checks each operation itself */
  permissions: Permission[]
}

export interface AuthSession {
  accessToken: string
  expiresIn: number
  user: AuthUser
}

/** A field path and message from a 422, e.g. { field: 'endDate', message: 'A tenancy must have an end date' } */
export interface FieldError {
  field: string
  message: string
}

export class ApiError extends Error {
  readonly code: string
  readonly retryAfterSeconds?: number
  /** Present on VALIDATION_ERROR: which field each message belongs beside */
  readonly fields: FieldError[]

  constructor(code: string, message: string, retryAfterSeconds?: number, fields: FieldError[] = []) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
    this.fields = fields
  }
}

/**
 * The gate action never reached the server and has been saved on this device instead. Not a
 * failure: the record is safe and uploads on the next sync.
 */
export class QueuedOfflineError extends Error {
  readonly code = 'QUEUED_OFFLINE'

  constructor() {
    super('Saved on this device')
    this.name = 'QueuedOfflineError'
  }
}

/** Sends a request and returns `data`, or throws ApiError for an API error. Network failures throw as-is. */
export async function send<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { method: 'POST', ...init })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const error = body?.error
    throw new ApiError(error?.code ?? 'INTERNAL_ERROR', error?.message ?? res.statusText, error?.retryAfterSeconds, error?.details?.fields ?? [])
  }
  return body?.data
}

/** POST /auth/login. The refresh token comes back as an httpOnly cookie. */
export function login(values: LoginFormValues) {
  return send<AuthSession>('/api/v1/auth/login', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  })
}

/**
 * POST /auth/forgot-password. Always succeeds: the office is told someone cannot sign in, and
 * the reply never says whether the number is registered.
 */
export function forgotPassword(phone: string) {
  return send<{ requested: true }>('/api/v1/auth/forgot-password', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  })
}

/** POST /auth/set-password. Spends the one-time code the society office handed over. */
export function setPassword(code: string, password: string) {
  return send<{ passwordSet: true }>('/api/v1/auth/set-password', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, password }),
  })
}

let refreshing: Promise<AuthSession> | null = null

/**
 * POST /auth/refresh with the httpOnly cookie. The server rotates the token and revokes the
 * session if an old one is reused, so only one refresh may run at a time: concurrent callers
 * share the request, and a Web Lock serialises refreshes across tabs.
 */
export function refresh() {
  const request = () => send<AuthSession>('/api/v1/auth/refresh')
  refreshing ??= (navigator.locks ? navigator.locks.request('civickey-refresh', request) : request()).finally(() => {
    refreshing = null
  })
  return refreshing
}

/** POST /auth/logout. An expired access token is refreshed once so the server session is still revoked. */
export async function logout(accessToken: string) {
  const request = (token: string) => send('/api/v1/auth/logout', { headers: { Authorization: `Bearer ${token}` } })
  try {
    await request(accessToken)
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'TOKEN_EXPIRED')) throw error
    await request((await refresh()).accessToken)
  }
}
