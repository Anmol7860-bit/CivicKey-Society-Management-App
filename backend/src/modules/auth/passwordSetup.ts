import { createHash, randomInt } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { authSessions, passwordSetupCodes, refreshTokens, users } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { assertSameSociety, assertState, UUID } from '../access/scope.js'
import { maskIdentifier, recordAuditEvent, type DbExecutor } from '../audit/audit.service.js'
import { hashPassword } from './password.js'

/** Long enough that a code is not worth guessing, short enough to read out over the phone. */
const CODE_LENGTH = 12
/** No I, O, 0, 1: the code gets written on paper and read back */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_TTL_HOURS = 72

export const setPasswordSchema = z
  .object({
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

/** Accepts the code however it was typed: spaces, dashes and lower case all work. */
export function normalizeCode(raw: string) {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

/** Groups of four, as the Admin screen shows it. */
export function formatCode(code: string) {
  return code.replace(/(.{4})(?=.)/g, '$1-')
}

function generateCode() {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex')

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
    await tx.insert(passwordSetupCodes).values({ userId, codeHash: hashCode(code), expiresAt, issuedBy: ctx.userId })
    await recordAuditEvent(tx, {
      eventType: 'PASSWORD_SETUP_CODE_ISSUED',
      actorUserId: ctx.userId,
      metadata: { userId, societyId: target.societyId },
    })
    return { code: formatCode(code), expiresAt: expiresAt.toISOString(), user: { id: target.id, name: target.name } }
  }
  return executor ? run(executor) : db.transaction(run)
}

/**
 * Spends a code and sets the password. Every existing session of that account is revoked, so a
 * reset also signs out whoever was using the old password.
 */
export function setPasswordWithCode(
  body: z.infer<typeof setPasswordSchema>,
  request: { ipAddress: string | null; userAgent: string | null },
) {
  return db.transaction(async (tx) => {
    const now = new Date()
    const [row] = await tx
      .select({ id: passwordSetupCodes.id, userId: passwordSetupCodes.userId, isActive: users.isActive })
      .from(passwordSetupCodes)
      .innerJoin(users, eq(users.id, passwordSetupCodes.userId))
      .where(
        and(
          eq(passwordSetupCodes.codeHash, hashCode(body.code)),
          isNull(passwordSetupCodes.usedAt),
          gt(passwordSetupCodes.expiresAt, now),
        ),
      )
      .for('update', { of: passwordSetupCodes })

    if (!row || !row.isActive) {
      await recordAuditEvent(tx, {
        eventType: 'PASSWORD_SET_FAILED',
        actorUserId: row?.userId ?? null,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        metadata: row ? { reason: 'USER_INACTIVE' } : { reason: 'CODE_NOT_USABLE' },
      })
      throw new AppError(400, 'INVALID_CODE', 'That code is not valid any more. Ask the society office for a new one.')
    }

    await tx.update(passwordSetupCodes).set({ usedAt: now }).where(eq(passwordSetupCodes.id, row.id))
    await tx
      .update(users)
      .set({ passwordHash: await hashPassword(body.password), updatedAt: now })
      .where(eq(users.id, row.userId))
    // The old password is gone, so nothing issued under it may keep working
    const revoked = await tx
      .update(authSessions)
      .set({ revokedAt: now, revokedReason: 'PASSWORD_CHANGED' })
      .where(and(eq(authSessions.userId, row.userId), isNull(authSessions.revokedAt)))
      .returning({ id: authSessions.id })
    for (const session of revoked) {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.sessionId, session.id), isNull(refreshTokens.revokedAt)))
    }
    await recordAuditEvent(tx, {
      eventType: 'PASSWORD_SET_WITH_CODE',
      actorUserId: row.userId,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
      metadata: { sessionsRevoked: revoked.length },
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
  const [user] = await db.select({ id: users.id, societyId: users.societyId }).from(users).where(eq(users.phone, phone))
  await recordAuditEvent(db, {
    eventType: 'PASSWORD_RESET_REQUESTED',
    actorUserId: user?.id ?? null,
    ipAddress: request.ipAddress,
    userAgent: request.userAgent,
    metadata: { identifierType: 'phone', identifier: maskIdentifier('phone', phone), ...(user ? { societyId: user.societyId } : { known: false }) },
  })
  return { requested: true }
}
