import { and, eq, getTableColumns, isNull } from 'drizzle-orm'
import { env } from '../../config/env.js'
import { db } from '../../db/client.js'
import { authSessions, refreshTokens, roles, userRoles, users, type Role, type User } from '../../db/schema.js'
import { loadPermissions, type Permission } from '../access/permissions.js'
import { AppError } from '../../lib/errors.js'
import { assertPhoneNotLocked, clearFailedAttempts, countFailedAttempt } from './throttle.js'
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
  /** What the UI may show; the backend still checks each operation */
  permissions: Permission[]
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

/** A user with their role from user_roles; null when no role is assigned. */
type UserWithRole = User & { role: Role | null }

const userWithRole = { ...getTableColumns(users), role: roles.name }

export function toSafeUser(user: User & { role: Role }, permissions: Permission[]): SafeUser {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    role: user.role,
    societyId: user.societyId,
    permissions,
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

async function buildAuthResult(
  executor: DbExecutor,
  user: User & { role: Role },
  sessionId: string,
  refresh: { token: string; expiresAt: Date },
): Promise<AuthResult> {
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
    user: toSafeUser(user, await loadPermissions(executor, user.id, user.role)),
  }
}

/** Ends a session and every token in its family. Returns false if it was already revoked. */
async function revokeSession(executor: DbExecutor, sessionId: string, reason: string, now: Date) {
  const revoked = await executor
    .update(authSessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)))
    .returning({ id: authSessions.id })
  await executor
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)))
  return revoked.length > 0
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function findUser(identifier: LoginIdentifier) {
  const column = identifier.type === 'phone' ? users.phone : users.email
  const [user] = await db
    .select(userWithRole)
    .from(users)
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .leftJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(column, identifier.value))
    .limit(1)
  return user as UserWithRole | undefined
}

// Same response for unknown user and wrong password, so accounts cannot be enumerated
const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid login credentials')

export async function login(
  identifier: LoginIdentifier,
  password: string,
  context: RequestContext,
  selectedRole?: Role,
): Promise<AuthResult> {
  // Refused before the password is looked at, so a locked account cannot be probed for whether
  // the guess happened to be right
  await assertPhoneNotLocked(identifier.value, context)

  const user = await findUser(identifier)
  const passwordMatches = await verifyPassword(password, user?.passwordHash)
  const auditBase = {
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  }
  const attempted = { identifierType: identifier.type, identifier: maskIdentifier(identifier.type, identifier.value) }

  if (!user || !passwordMatches) {
    // The attempt that reaches the limit answers 401 like the rest; the next one is refused
    await countFailedAttempt(identifier.value)
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

  const role = user.role
  if (!role) {
    await recordAuditEvent(db, {
      ...auditBase,
      eventType: 'AUTH_LOGIN_FAILED',
      actorUserId: user.id,
      metadata: { ...attempted, reason: 'ROLE_NOT_ASSIGNED' },
    })
    throw new AppError(403, 'ROLE_NOT_ASSIGNED', 'No active role is assigned to this user')
  }

  // Also after the password check, so an account's role is never revealed without it
  if (selectedRole && selectedRole !== role) {
    await recordAuditEvent(db, {
      ...auditBase,
      eventType: 'AUTH_LOGIN_FAILED',
      actorUserId: user.id,
      metadata: { ...attempted, reason: 'ROLE_MISMATCH', selectedRole },
    })
    throw new AppError(403, 'ROLE_MISMATCH', 'Account does not have the selected role')
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

    // A correct password clears this phone's failures; the caller's IP window keeps running
    await clearFailedAttempts(identifier.value)

    return buildAuthResult(tx, { ...user, role }, session.id, refresh)
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
      .select({ token: refreshTokens, session: authSessions, user: users, role: roles.name })
      .from(refreshTokens)
      .innerJoin(authSessions, eq(refreshTokens.sessionId, authSessions.id))
      .innerJoin(users, eq(authSessions.userId, users.id))
      .leftJoin(userRoles, eq(userRoles.userId, users.id))
      .leftJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .for('update', { of: [refreshTokens, authSessions] })

    if (!row) {
      await recordAuditEvent(tx, { ...auditBase, eventType: 'AUTH_REFRESH_FAILED', metadata: { reason: 'UNKNOWN_TOKEN' } })
      return { ok: false, error: invalidRefreshToken() }
    }

    const { token, session, user, role } = row
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

    if (!role) {
      await revokeSession(tx, session.id, 'ROLE_NOT_ASSIGNED', now)
      await recordAuditEvent(tx, {
        ...auditBase,
        eventType: 'AUTH_REFRESH_FAILED',
        actorUserId: user.id,
        metadata: { ...sessionMeta, reason: 'ROLE_NOT_ASSIGNED' },
      })
      return { ok: false, error: new AppError(403, 'ROLE_NOT_ASSIGNED', 'No active role is assigned to this user') }
    }

    const next = await issueRefreshToken(tx, session.id, now)
    await tx.update(refreshTokens).set({ rotatedAt: now, replacedById: next.id }).where(eq(refreshTokens.id, token.id))
    await tx
      .update(authSessions)
      .set({ lastUsedAt: now, expiresAt: next.expiresAt })
      .where(eq(authSessions.id, session.id))

    return { ok: true, result: await buildAuthResult(tx, { ...user, role }, session.id, next) }
  })

  if (!outcome.ok) throw outcome.error
  return outcome.result
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

/**
 * Revokes the caller's session and all its refresh tokens. Idempotent: logging out an
 * already-revoked session changes nothing and records no second event.
 */
export async function logout(userId: string, sessionId: string, context: RequestContext) {
  await db.transaction(async (tx) => {
    // Scoped to the user, so a session id can only ever end its owner's session
    const [session] = await tx
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)))
      .for('update')
    if (!session) return

    if (await revokeSession(tx, session.id, 'LOGOUT', new Date())) {
      await recordAuditEvent(tx, {
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        eventType: 'AUTH_LOGOUT',
        actorUserId: userId,
        metadata: { sessionId: session.id },
      })
    }
  })
}
