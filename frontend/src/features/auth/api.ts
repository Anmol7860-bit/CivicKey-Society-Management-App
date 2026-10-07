import type { LoginFormValues } from './components/LoginForm'

export type Role = 'RESIDENT' | 'GUARD' | 'ADMIN'

export interface AuthUser {
  id: string
  name: string
  phone: string | null
  email: string | null
  role: Role
  societyId: string | null
}

export interface AuthSession {
  accessToken: string
  expiresIn: number
  user: AuthUser
}

export class ApiError extends Error {
  readonly code: string
  readonly retryAfterSeconds?: number

  constructor(code: string, message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** POST /auth/login. The refresh token comes back as an httpOnly cookie. */
export async function login(values: LoginFormValues): Promise<AuthSession> {
  const res = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const error = body?.error
    throw new ApiError(error?.code ?? 'INTERNAL_ERROR', error?.message ?? res.statusText, error?.retryAfterSeconds)
  }
  return body.data
}
