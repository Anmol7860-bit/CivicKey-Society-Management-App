import { createHmac, randomInt } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { db } from '../../db/client.js'
import { permissions as permissionTable, passwordSetupCodes, userPermissions, users } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { assertSameSociety, assertState, UUID } from '../access/scope.js'
import { maskIdentifier, recordAuditEvent, type DbExecutor } from '../audit/audit.service.js'
import { revokeAllSessions } from './auth.service.js'
import { hashPassword } from './password.js'
import { enqueueNotification } from '../notification/outbox.service.js'
import { assertPhoneNotLocked, clearFailedAttempts, countFailedAttempt } from './throttle.js'

/**
 * Four digits, as the office asked: short enough to read out over the phone and type on a
 * keypad. Four digits are only 10,000 codes, so three things carry the weight instead of length.
 * The code is spendable only together with the account's own mobile number; its hash is keyed and
 * bound to the account, so one account's code can never match another's; and a code is retired
 * after MAX_ATTEMPTS wrong tries, which caps a guesser at 5 tries in 10,000 per issued code. The
 * phone's login throttle counts the failures as well.
 */
const CODE_LENGTH = 4
const MAX_ATTEMPTS = 5
const CODE_TTL_HOURS = 72

export const setPasswordSchema = z
  .object({
    /** The account the code belongs to: a code alone is not enough to set a password */
    phone: z
      .string({ error: 'Enter your mobile number' })
      .trim()
      .regex(/^[6-9]\d{9}$/, 'Phone must be a 10-digit Indian mobile number'),
    code: z
      .string({ error: 'Enter the code the office gave you' })
      .trim()
      .max(32, 'That is not a valid code')
      .transform(normalizeCode),
    password: z
      .string({ error: 'Choose a password' })
      .min(10, 'Use at least 10 characters')
      .max(128, 'Password is too long')
      .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), 'Use at least one letter and one number'),
  })
  .strict()

export const forgotPasswordSchema = z
  .object({
    phone: z
      .string({ error: 'Enter your mobile number' })
      .trim()
      .regex(/^[6-9]\d{9}$/, 'Phone must be a 10-digit Indian mobile number'),
  })
  .strict()

/** Accepts the code however it was typed: spaces and dashes around the digits all work. */
export function normalizeCode(raw: string) {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

function generateCode() {
  return randomInt(0, 10 ** CODE_LENGTH)
    .toString()
    .padStart(CODE_LENGTH, '0')
}

/**
 * Keyed and bound to the account. Keyed, because the SHA-256 of 0000-9999 is a ten-thousand-row
 * table anyone can build; bound to the account, because a code must mean nothing on another one.
 */
const hashCode = (userId: string, code: string) =>
  createHmac('sha256', env.AUTH_RATE_KEY).update(`setup:${userId}:${code}`).digest('hex')

/**
 * Issues a one-time code for someone to set their own password, retiring any code they already
 * hold. There is no SMS or email sender yet, so the code is returned to the Admin to hand over
 * in person; it is never written to the audit log.
 */
export function issueSetupCode(ctx: AuthContext, userId: string, executor?: DbExecutor) {
  const run = async (tx: DbExecutor) => {
    const [target] = UUID.test(userId)
      ? await tx
          .select({ id: users.id, name: users.name, societyId: users.societyId, isActive: users.isActive })
          .from(users)
          .where(eq(users.id, userId))
      : []
    if (!target) throw new AppError(404, 'NOT_FOUND', 'User not found')
    // A platform-level account has no society; only its own holder can reset it
    if (target.societyId === null) throw new AppError(404, 'NOT_FOUND', 'User not found')
    await assertSameSociety(ctx, target.societyId)
    assertState(target.isActive, 'This account is deactivated')

    const code = generateCode()
    const expiresAt = new Date(Date.now() + CODE_TTL_HOURS * 60 * 60 * 1000)
    // Spend the previous code first: the unique index allows only one live code per user
    await tx
      .update(passwordSetupCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordSetupCodes.userId, userId), isNull(passwordSetupCodes.usedAt)))
    await tx.insert(passwordSetupCodes).values({ userId, codeHash: hashCode(userId, code), expiresAt, issuedBy: ctx.userId })
    await recordAuditEvent(tx, {
      eventType: 'PASSWORD_SETUP_CODE_ISSUED',
      actorUserId: ctx.userId,
      metadata: { userId, societyId: target.societyId },
    })
    return { code, expiresAt: expiresAt.toISOString(), user: { id: target.id, name: target.name } }
  }
  return executor ? run(executor) : db.transaction(run)
}

/**
 * Spends a code and sets the password. The code counts only for the account holding that mobile
 * number, and a wrong code is counted against the code and against the number's login throttle.
 * Every existing session of that account is revoked, so a reset also signs out whoever was using
 * the old password.
 */
export async function setPasswordWithCode(
  body: z.infer<typeof setPasswordSchema>,
  request: { ipAddress: string | null; userAgent: string | null },
) {
  const now = new Date()
  // A locked number is refused before the code is looked at, so a lock cannot be probed
  await assertPhoneNotLocked(body.phone, request)
  const [account] = await db.select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.phone, body.phone))
  const [live] = account
    ? await db
        .select({ id: passwordSetupCodes.id, codeHash: passwordSetupCodes.codeHash, expiresAt: passwordSetupCodes.expiresAt, attempts: passwordSetupCodes.attempts })
        .from(passwordSetupCodes)
        .where(and(eq(passwordSetupCodes.userId, account.id), isNull(passwordSetupCodes.usedAt)))
    : []
  const matches = Boolean(live && live.expiresAt > now && live.codeHash === hashCode(account!.id, body.code))

  if (!matches || !account?.isActive) {
    // A wrong try is spent: the code dies after MAX_ATTEMPTS of them, which is what makes four
    // digits safe. A code that has run out is retired, not merely refused.
    if (live && !matches) {
      const attempts = live.attempts + 1
      await db
        .update(passwordSetupCodes)
        .set({ attempts, ...(attempts >= MAX_ATTEMPTS ? { usedAt: now } : {}) })
        .where(eq(passwordSetupCodes.id, live.id))
    }
    if (account) await countFailedAttempt(body.phone)
    await recordAuditEvent(db, {
      eventType: 'PASSWORD_SET_FAILED',
      actorUserId: account?.id ?? null,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
      metadata: account && !account.isActive ? { reason: 'USER_INACTIVE' } : { reason: 'CODE_NOT_USABLE' },
    })
    throw new AppError(400, 'INVALID_CODE', 'That code is not valid any more. Ask the society office for a new one.')
  }

  return db.transaction(async (tx) => {
    // Spending the code is the conditional write that makes it one-time: two requests arriving
    // together with the same right code, and only the one that flips used_at sets a password
    const spent = await tx
      .update(passwordSetupCodes)
      .set({ usedAt: now })
      .where(and(eq(passwordSetupCodes.id, live!.id), isNull(passwordSetupCodes.usedAt)))
      .returning({ id: passwordSetupCodes.id })
    if (spent.length === 0) {
      throw new AppError(400, 'INVALID_CODE', 'That code is not valid any more. Ask the society office for a new one.')
    }

    await tx
      .update(users)
      .set({ passwordHash: await hashPassword(body.password), updatedAt: now })
      .where(eq(users.id, account.id))
    // The old password is gone, so nothing issued under it may keep working
    const revoked = await revokeAllSessions(tx, account.id, 'PASSWORD_CHANGED', now)
    // Proving control of the account clears the failures counted against its number
    await clearFailedAttempts(body.phone)
    await recordAuditEvent(tx, {
      eventType: 'PASSWORD_SET_WITH_CODE',
      actorUserId: account.id,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
      metadata: { sessionsRevoked: revoked },
    })
    return { passwordSet: true }
  })
}

/**
 * Records that someone cannot sign in. There is no SMS sender yet, so this cannot mail a link:
 * it lands in the audit log, where the office sees it on Security activity and issues a code.
 * The reply never says whether the number is registered.
 */
export async function requestPasswordReset(
  phone: string,
  request: { ipAddress: string | null; userAgent: string | null },
) {
  const [user] = await db
    .select({ id: users.id, name: users.name, societyId: users.societyId })
    .from(users)
    .where(eq(users.phone, phone))
  // The office is told so somebody acts on it. An unknown number notifies nobody, which is also
  // what keeps the caller from learning whether a number is registered.
  if (user?.societyId) {
    const office = await db
      .select({ id: userPermissions.userId })
      .from(userPermissions)
      .innerJoin(permissionTable, eq(permissionTable.id, userPermissions.permissionId))
      .innerJoin(users, eq(users.id, userPermissions.userId))
      .where(and(eq(permissionTable.code, 'USER_MANAGE'), eq(users.societyId, user.societyId), eq(users.isActive, true)))
    if (office.length > 0) {
      await enqueueNotification(db, {
        societyId: user.societyId,
        eventType: 'PASSWORD_RESET_REQUESTED',
        entityType: 'user',
        entityId: user.id,
        recipientIds: office.map((row) => row.id),
        payload: { name: user.name, phone: maskIdentifier('phone', phone) },
      })
    }
  }
  await recordAuditEvent(db, {
    eventType: 'PASSWORD_RESET_REQUESTED',
    actorUserId: user?.id ?? null,
    ipAddress: request.ipAddress,
    userAgent: request.userAgent,
    metadata: { identifierType: 'phone', identifier: maskIdentifier('phone', phone), ...(user ? { societyId: user.societyId } : { known: false }) },
  })
  return { requested: true }
}
