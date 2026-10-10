import type { RequestHandler } from 'express'
import { errors } from 'jose'
import { userRole, type Role } from '../db/schema.js'
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

/** Verifies the Bearer access token and attaches req.ctx for downstream authorization. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
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

  req.ctx = { userId: sub, sessionId: sid, societyId, role: role as Role }
  next()
}
