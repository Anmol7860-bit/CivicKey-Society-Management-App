import { createHash, randomBytes } from 'node:crypto'
import { SignJWT } from 'jose'
import { env } from '../../config/env.js'
import type { Role } from '../../db/schema.js'

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET)

export const ACCESS_TOKEN_ALGORITHM = 'HS256'

export interface AccessTokenClaims {
  userId: string
  sessionId: string
  role: Role
  societyId: string | null
}

/** Short-lived JWT carrying the context downstream RBAC needs (FR-AUTH-06). */
export function signAccessToken(claims: AccessTokenClaims) {
  return new SignJWT({ role: claims.role, society_id: claims.societyId, sid: claims.sessionId })
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(accessSecret)
}

/** 256-bit random opaque token. Only its hash is stored. */
export function generateRefreshToken() {
  return randomBytes(32).toString('base64url')
}

/** SHA-256 is sufficient for high-entropy random tokens and allows indexed lookup. */
export function hashRefreshToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function refreshTokenExpiry(from = new Date()) {
  return new Date(from.getTime() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
}
