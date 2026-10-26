import { createHmac } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { env } from '../../config/env.js'
import { db } from '../../db/client.js'
import { authRateLimitBuckets } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import { recordAuditEvent } from '../audit/audit.service.js'

const WINDOW_MINUTES = env.LOGIN_RATE_LIMIT_WINDOW_MINUTES
const LOCK_MINUTES = env.LOGIN_RATE_LIMIT_WINDOW_MINUTES

/**
 * The bucket's key. An HMAC, not the value: the table records that something was throttled
 * without recording whose phone number or address it was.
 */
function bucketKey(type: 'PHONE' | 'IP', value: string) {
  return createHmac('sha256', env.AUTH_RATE_KEY).update(`${type}:${value}`).digest('hex')
}

export interface ThrottleContext {
  ipAddress?: string | null
  userAgent?: string | null
}

/**
 * Records that a throttle fired and refuses the request. The audit row names which kind of bucket
 * it was, never the phone or the address: those are only ever held as HMACs.
 */
async function tooMany(retryAfterSeconds: number, bucketType: 'PHONE' | 'IP', context: ThrottleContext = {}) {
  try {
    await recordAuditEvent(db, {
      eventType: 'AUTH_LOGIN_RATE_LIMITED',
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      metadata: { bucketType },
    })
  } catch {
    // The refusal matters more than its audit row; losing the row must not let the request through
  }
  return new AppError(429, 'TOO_MANY_REQUESTS', 'Too many login attempts. Try again later.', { retryAfterSeconds })
}

interface Bucket {
  requestCount: number
  lockedUntil: Date | null
}

/**
 * Adds one to a bucket, starting a new window if the old one has run out.
 *
 * One statement, so two requests arriving together cannot both read 4 and both write 5. The
 * window is compared in SQL against the database clock, never against this process's clock.
 */
async function bump(type: 'PHONE' | 'IP', value: string): Promise<Bucket> {
  const window = sql.raw(`interval '${WINDOW_MINUTES} minutes'`)
  const [row] = await db
    .insert(authRateLimitBuckets)
    .values({ bucketKey: bucketKey(type, value), bucketType: type, requestCount: 1 })
    .onConflictDoUpdate({
      target: authRateLimitBuckets.bucketKey,
      set: {
        requestCount: sql`case when ${authRateLimitBuckets.windowStartedAt} <= now() - ${window} then 1 else ${authRateLimitBuckets.requestCount} + 1 end`,
        windowStartedAt: sql`case when ${authRateLimitBuckets.windowStartedAt} <= now() - ${window} then now() else ${authRateLimitBuckets.windowStartedAt} end`,
        // A lock from an expired window is dropped along with its count
        lockedUntil: sql`case when ${authRateLimitBuckets.windowStartedAt} <= now() - ${window} then null else ${authRateLimitBuckets.lockedUntil} end`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ requestCount: authRateLimitBuckets.requestCount, lockedUntil: authRateLimitBuckets.lockedUntil })
  return row!
}

async function read(type: 'PHONE' | 'IP', value: string) {
  const [row] = await db
    .select({ requestCount: authRateLimitBuckets.requestCount, lockedUntil: authRateLimitBuckets.lockedUntil, windowStartedAt: authRateLimitBuckets.windowStartedAt })
    .from(authRateLimitBuckets)
    .where(eq(authRateLimitBuckets.bucketKey, bucketKey(type, value)))
  return row
}

const secondsUntil = (at: Date) => Math.max(1, Math.ceil((at.getTime() - Date.now()) / 1000))

/** Counts this request against the caller's address and refuses it once the window's cap is passed. */
export async function countRequestFromIp(ip: string, context: ThrottleContext = {}) {
  const { requestCount } = await bump('IP', ip)
  if (requestCount > env.LOGIN_RATE_LIMIT_IP_MAX) throw await tooMany(WINDOW_MINUTES * 60, 'IP', context)
}

/**
 * Refuses a locked phone before the password is looked at, so a lock cannot be probed for whether
 * the password happens to be right.
 */
export async function assertPhoneNotLocked(phone: string, context: ThrottleContext = {}) {
  const bucket = await read('PHONE', phone)
  const lockedUntil = bucket?.lockedUntil
  // A lock whose window has passed is treated as gone; the next failure starts a fresh one
  if (lockedUntil && lockedUntil.getTime() > Date.now()) throw await tooMany(secondsUntil(lockedUntil), 'PHONE', context)
}

/**
 * Records a failed credential attempt. The attempt that reaches the limit still answers with the
 * same 401 as the ones before it - the caller learns nothing from the threshold - and starts the
 * lock that refuses everything after it.
 */
export async function countFailedAttempt(phone: string) {
  const { requestCount } = await bump('PHONE', phone)
  if (requestCount < env.LOGIN_RATE_LIMIT_MAX) return
  await db
    .update(authRateLimitBuckets)
    .set({ lockedUntil: sql.raw(`now() + interval '${LOCK_MINUTES} minutes'`), updatedAt: sql`now()` })
    .where(eq(authRateLimitBuckets.bucketKey, bucketKey('PHONE', phone)))
}

/** A correct password clears that phone's failures. The caller's IP window is left running. */
export async function clearFailedAttempts(phone: string) {
  await db.delete(authRateLimitBuckets).where(eq(authRateLimitBuckets.bucketKey, bucketKey('PHONE', phone)))
}
