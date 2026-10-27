import type { RequestHandler } from 'express'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { errors } from 'jose'
import { db } from '../db/client.js'
import { authSessions, userRole, type Role } from '../db/schema.js'
import { AppError } from '../lib/errors.js'
import type { Permission } from '../modules/access/permissions.js'
import { verifyAccessToken } from '../modules/auth/tokens.js'

export interface AuthContext {
  userId: string
  /** Session (token family) the access token was issued for */
  sessionId: string
  societyId: string | null
  role: Role
  /** Set by requirePermission from the database */
  permissions?: Permission[]
}

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth; undefined on public routes */
      ctx?: AuthContext
    }
  }
}

// Messages stay generic so clients learn nothing about why a token failed beyond the code
const tokenMissing = () => new AppError(401, 'TOKEN_MISSING', 'Authentication required')
const tokenInvalid = () => new AppError(401, 'TOKEN_INVALID', 'Authentication failed')
const tokenExpired = () => new AppError(401, 'TOKEN_EXPIRED', 'Authentication failed')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether the session the token was issued for is still live.
 *
 * The token alone is not enough: it stays verifiable until it expires, so without this a logout
 * or a revoked token family would keep working for the rest of the access token's life.
 */
async function sessionIsLive(sessionId: string) {
  // A forged sid would make Postgres reject the uuid comparison, so it is shaped first
  if (!UUID.test(sessionId)) return false
  const [session] = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, new Date())))
  return session !== undefined
}

function authenticate(requireLiveSession: boolean): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization')
    if (!header) return next(tokenMissing())

    const [scheme, token, ...rest] = header.trim().split(/\s+/)
    if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) return next(tokenInvalid())

    let payload
    try {
      payload = await verifyAccessToken(token)
    } catch (error) {
      return next(error instanceof errors.JWTExpired ? tokenExpired() : tokenInvalid())
    }

    const { sub, sid, role, society_id: societyId } = payload
    if (
      typeof sub !== 'string' ||
      typeof sid !== 'string' ||
      !userRole.enumValues.includes(role as Role) ||
      (societyId !== null && typeof societyId !== 'string')
    ) {
      return next(tokenInvalid())
    }

    if (requireLiveSession && !(await sessionIsLive(sid))) return next(tokenInvalid())

    req.ctx = { userId: sub, sessionId: sid, societyId, role: role as Role }
    next()
  }
}

/** Verifies the Bearer access token and attaches req.ctx for downstream authorization. */
export const requireAuth = authenticate(true)

/**
 * The same, without insisting the session is still live: logging out of a session that has
 * already ended must still succeed rather than answer 401 to someone on their way out.
 */
export const requireAuthForLogout = authenticate(false)
