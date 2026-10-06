import { and, eq, isNull } from 'drizzle-orm'
import { env } from '../../config/env.js'
import { db } from '../../db/client.js'
import { authSessions, refreshTokens, users, type Role, type User } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import { maskIdentifier, recordAuditEvent, type DbExecutor } from '../audit/audit.service.js'
import type { LoginIdentifier } from './auth.schemas.js'
import { verifyPassword } from './password.js'
import { generateRefreshToken, hashRefreshToken, refreshTokenExpiry, signAccessToken } from './tokens.js'

export interface RequestContext {
  ipAddress: string | null
  userAgent: string | null
}

/** User fields safe to return to clients. Never includes password_hash. */
export interface SafeUser {
  id: string
  name: string
  phone: string | null
  email: string | null
  role: Role
  societyId: string | null
}

/** Returned by login and refresh. The route puts refreshToken in a cookie, never in the body. */
export interface AuthResult {
  accessToken: string
  expiresIn: number
  refreshToken: string
  refreshTokenExpiresAt: Date
  sessionId: string
  user: SafeUser
}

export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    role: user.role,
    societyId: user.societyId,
  }
}

/** Creates a refresh token for the session and stores only its hash. */
async function issueRefreshToken(executor: DbExecutor, sessionId: string, now: Date) {
  const token = generateRefreshToken()
  const expiresAt = refreshTokenExpiry(now)
  const [row] = await executor
    .insert(refreshTokens)
    .values({ sessionId, tokenHash: hashRefreshToken(token), expiresAt })
    .returning({ id: refreshTokens.id })
  if (!row) throw new Error('Refresh token insert returned no row')
  return { id: row.id, token, expiresAt }
}

async function buildAuthResult(user: User, sessionId: string, refresh: { token: string; expiresAt: Date }): Promise<AuthResult> {
  const accessToken = await signAccessToken({
    userId: user.id,
    sessionId,
    role: user.role,
    societyId: user.societyId,
  })
  return {
    accessToken,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt,
    sessionId,
    user: toSafeUser(user),
  }
}

/** Ends a session and every token in its family. */
async function revokeSession(executor: DbExecutor, sessionId: string, reason: string, now: Date) {
  await executor
    .update(authSessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)))
  await executor
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)))
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function findUser(identifier: LoginIdentifier) {
  const column = identifier.type === 'phone' ? users.phone : users.email
  const [user] = await db.select().from(users).where(eq(column, identifier.value)).limit(1)
  return user
}

// Same response for unknown user and wrong password, so accounts cannot be enumerated
const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid login credentials')

export async function login(identifier: LoginIdentifier, password: string, context: RequestContext): Promise<AuthResult> {
  const user = await findUser(identifier)
  const passwordMatches = await verifyPassword(password, user?.passwordHash)
  const auditBase = {
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  }
  const attempted = { identifierType: identifier.type, identifier: maskIdentifier(identifier.type, identifier.value) }

  if (!user || !passwordMatches) {
    await recordAuditEvent(db, {
      ...auditBase,
      eventType: 'AUTH_LOGIN_FAILED',
      actorUserId: user?.id ?? null,
      metadata: { ...attempted, reason: 'INVALID_CREDENTIALS' },
    })
    throw invalidCredentials()
  }

  // Checked only after the password, so account status is never revealed to someone without it
  if (!user.isActive) {
    await recordAuditEvent(db, {
      ...auditBase,
      eventType: 'AUTH_LOGIN_FAILED',
      actorUserId: user.id,
      metadata: { ...attempted, reason: 'USER_INACTIVE' },
    })
    throw new AppError(403, 'USER_INACTIVE', 'User account is inactive')
  }

  const now = new Date()

  return db.transaction(async (tx) => {
    const [session] = await tx
      .insert(authSessions)
      .values({
        userId: user.id,
        userAgent: context.userAgent?.slice(0, 512) ?? null,
        ipAddress: context.ipAddress,
        expiresAt: refreshTokenExpiry(now),
      })
      .returning({ id: authSessions.id })

    if (!session) throw new Error('Session insert returned no row')

    const refresh = await issueRefreshToken(tx, session.id, now)

    await tx.update(users).set({ lastLoginAt: now, updatedAt: now }).where(eq(users.id, user.id))

    await recordAuditEvent(tx, {
      ...auditBase,
      eventType: 'AUTH_LOGIN_SUCCESS',
      actorUserId: user.id,
      metadata: { ...attempted, sessionId: session.id, role: user.role },
    })

    return buildAuthResult(user, session.id, refresh)
  })
}

// ---------------------------------------------------------------------------
// Refresh (rotation with reuse detection)
// ---------------------------------------------------------------------------

const invalidRefreshToken = () => new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid')

type RefreshOutcome = { ok: true; result: AuthResult } | { ok: false; error: AppError }

/**
 * Exchanges a refresh token for a new access token and a new refresh token.
 *
 * Each session is a token family. A token can be used once: it is then marked rotated
 * and linked to its replacement. Presenting a rotated token again means it was copied,
 * so the whole session is revoked and the user must sign in again.
 */
export async function refreshSession(rawToken: string | undefined, context: RequestContext): Promise<AuthResult> {
  if (!rawToken) throw invalidRefreshToken()

  const tokenHash = hashRefreshToken(rawToken)
  const now = new Date()
  const auditBase = { ipAddress: context.ipAddress, userAgent: context.userAgent }

  // Failures that write (revocations, audit) must commit, so the transaction returns
  // an outcome instead of throwing.
  const outcome = await db.transaction(async (tx): Promise<RefreshOutcome> => {
    // Row locks serialise concurrent refreshes of the same token and races with logout
    const [row] = await tx
      .select({ token: refreshTokens, session: authSessions, user: users })
      .from(refreshTokens)
      .innerJoin(authSessions, eq(refreshTokens.sessionId, authSessions.id))
      .innerJoin(users, eq(authSessions.userId, users.id))
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .for('update', { of: [refreshTokens, authSessions] })

    if (!row) {
      await recordAuditEvent(tx, { ...auditBase, eventType: 'AUTH_REFRESH_FAILED', metadata: { reason: 'UNKNOWN_TOKEN' } })
      return { ok: false, error: invalidRefreshToken() }
    }

    const { token, session, user } = row
    const sessionMeta = { sessionId: session.id }

    if (token.rotatedAt) {
      await revokeSession(tx, session.id, 'REFRESH_TOKEN_REUSE', now)
      await recordAuditEvent(tx, {
        ...auditBase,
        eventType: 'AUTH_REFRESH_REUSE_DETECTED',
        actorUserId: user.id,
        metadata: { ...sessionMeta, tokenId: token.id, rotatedAt: token.rotatedAt.toISOString() },
      })
      return { ok: false, error: invalidRefreshToken() }
    }

    if (session.revokedAt || token.revokedAt) {
      await recordAuditEvent(tx, {
        ...auditBase,
        eventType: 'AUTH_REFRESH_FAILED',
        actorUserId: user.id,
        metadata: { ...sessionMeta, reason: 'SESSION_REVOKED' },
      })
      return { ok: false, error: invalidRefreshToken() }
    }

    if (token.expiresAt <= now) {
      await recordAuditEvent(tx, {
        ...auditBase,
        eventType: 'AUTH_REFRESH_FAILED',
        actorUserId: user.id,
        metadata: { ...sessionMeta, reason: 'EXPIRED' },
      })
      return { ok: false, error: new AppError(401, 'SESSION_EXPIRED', 'Session has expired') }
    }

    if (!user.isActive) {
      await revokeSession(tx, session.id, 'USER_INACTIVE', now)
      await recordAuditEvent(tx, {
        ...auditBase,
        eventType: 'AUTH_REFRESH_FAILED',
        actorUserId: user.id,
        metadata: { ...sessionMeta, reason: 'USER_INACTIVE' },
      })
      return { ok: false, error: new AppError(403, 'USER_INACTIVE', 'User account is inactive') }
    }

    const next = await issueRefreshToken(tx, session.id, now)
    await tx.update(refreshTokens).set({ rotatedAt: now, replacedById: next.id }).where(eq(refreshTokens.id, token.id))
    await tx
      .update(authSessions)
      .set({ lastUsedAt: now, expiresAt: next.expiresAt })
      .where(eq(authSessions.id, session.id))

    return { ok: true, result: await buildAuthResult(user, session.id, next) }
  })

  if (!outcome.ok) throw outcome.error
  return outcome.result
}
