import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import {
  notificationDeliveries,
  notificationOutbox,
  notifications,
  pushSubscriptions,
  users,
} from '../../db/schema.js'
import { logger } from '../../lib/logger.js'
import { ChannelError, EMAIL_EVENTS, sendEmail, sendPush } from './channels.js'
import { emitToUser, isConnected } from './realtime.js'
import type { NotificationEvent } from './outbox.service.js'

/** How many rows one pass takes. Fixed by the baseline. */
const BATCH = 50
/** A claim held longer than this belongs to a dispatcher that is gone, so it is taken over. */
const STALE_CLAIM_MINUTES = 5
/** Attempt 1 waits 30s, then 2m, 10m, 1h. After the fifth the channel is dead. */
const BACKOFF_SECONDS = [30, 120, 600, 3600]
const MAX_ATTEMPTS = 5

/** What a claim returns. Only the fields the dispatcher actually uses are selected. */
interface ClaimedEvent {
  id: string
  societyId: string
  eventType: NotificationEvent
  entityType: string
  entityId: string | null
  recipientIds: string[]
  payload: Record<string, unknown>
  attempts: number
}

interface ClaimedDelivery {
  id: string
  notificationId: string
  channel: 'IN_APP' | 'SOCKET' | 'PUSH' | 'EMAIL'
  attempts: number
}

/** The text each event turns into. Short, and free of anything that must not reach a lock screen. */
function describe(eventType: NotificationEvent, payload: Record<string, unknown>) {
  const name = typeof payload.name === 'string' ? payload.name : 'Someone'
  const flat = typeof payload.flat === 'string' ? payload.flat : 'your flat'
  switch (eventType) {
    case 'VISITOR_WAITING_APPROVAL':
      return { title: 'A visitor is at the gate', body: `${name} is asking for ${flat}. Approve or deny.` }
    case 'VISITOR_APPROVAL_REMINDER':
      return { title: 'Still waiting at the gate', body: `${name} is still waiting for ${flat}.` }
    case 'VISITOR_ESCALATED_TO_GATE':
      return { title: 'Nobody answered', body: `${name} at ${flat} was not answered. The guard decides.` }
    case 'VISITOR_DECIDED':
      return { title: 'Visitor decided', body: `${name} for ${flat}: ${String(payload.status ?? 'decided').toLowerCase()}.` }
    case 'VISITOR_ENTRY_REJECTED':
      return { title: 'Visitor turned away', body: `${name} was not let in for ${flat}.` }
    case 'VISITOR_ENTERED':
      return { title: 'Visitor let in', body: `${name} has entered for ${flat}.` }
    case 'VISITOR_EXITED':
      return { title: 'Visitor left', body: `${name} has left ${flat}.` }
    case 'DELIVERY_AT_GATE':
      return { title: 'A delivery is at the gate', body: `A delivery for ${flat} is waiting at the gate.` }
    case 'DELIVERY_COLLECTED':
      return { title: 'Delivery collected', body: `The delivery for ${flat} has been collected.` }
    case 'STAFF_ENTERED':
      return { title: 'Help arrived', body: `${name} has entered for ${flat}.` }
    case 'STAFF_EXITED':
      return { title: 'Help left', body: `${name} has left ${flat}.` }
    case 'OFFLINE_EVENT_NEEDS_REVIEW':
      return { title: 'An offline entry needs review', body: 'A gate entry recorded during an outage is waiting for the office.' }
    case 'INVOICE_GENERATED':
      return { title: 'A new bill is ready', body: `The maintenance bill for ${flat} is ready to view.` }
    case 'BILL_DUE_SOON':
      return { title: 'A bill is due soon', body: `The bill for ${flat} is due on ${String(payload.dueDate ?? 'its due date')}.` }
    case 'BILL_OVERDUE':
      return { title: 'A bill is overdue', body: `The bill for ${flat} was due on ${String(payload.dueDate ?? 'its due date')}.` }
    case 'PAYMENT_RECORDED':
      return { title: 'Payment recorded', body: `A payment for ${flat} has been recorded.` }
    case 'RECEIPT_READY':
      return { title: 'Your receipt is ready', body: `The receipt for ${flat} is ready to download.` }
    case 'TASK_ASSIGNED':
      return { title: 'A task is yours', body: `${String(payload.title ?? 'A task')} has been assigned to you.` }
    case 'TASK_DUE_SOON':
      return { title: 'A task is due tomorrow', body: `${String(payload.title ?? 'A task')} is due within a day.` }
    case 'TASK_OVERDUE':
      return { title: 'A task is overdue', body: `${String(payload.title ?? 'A task')} has passed its due date.` }
    case 'TASK_STATUS_CHANGED':
      return { title: 'A task moved on', body: `${String(payload.title ?? 'A task')} is now ${String(payload.status ?? 'updated')}.` }
  }
}

/**
 * Takes up to BATCH pending outbox rows for this process.
 *
 * SKIP LOCKED is what makes more than one dispatcher safe: a row another process is holding is
 * passed over rather than waited for, so two dispatchers share the queue instead of queueing
 * behind each other.
 */
async function claimOutbox() {
  const stale = sql.raw(`interval '${STALE_CLAIM_MINUTES} minutes'`)
  const rows = await db.execute(sql`
    with claimed as (
      select ${notificationOutbox.id} from ${notificationOutbox}
      where ${notificationOutbox.status} = 'PENDING'
         or (${notificationOutbox.status} = 'PROCESSING' and ${notificationOutbox.claimedAt} < now() - ${stale})
      order by ${notificationOutbox.createdAt}
      limit ${BATCH}
      for update skip locked
    )
    update ${notificationOutbox} o
      set status = 'PROCESSING', claimed_at = now(), attempts = o.attempts + 1
      from claimed
      where o.id = claimed.id
      returning o.id, o.society_id as "societyId", o.event_type as "eventType",
                o.entity_type as "entityType", o.entity_id as "entityId",
                o.recipient_ids as "recipientIds", o.payload, o.attempts
  `)
  // Raw SQL returns the column names it is given, so each one is aliased to what the code reads
  return rows.rows as unknown as ClaimedEvent[]
}

/**
 * Turns one outbox row into an in-app record per recipient and a delivery row per channel.
 *
 * The in-app record is the notification: it is written here, in one transaction, and is never
 * subject to a provider being up. The other channels are rows to be attempted afterwards.
 */
async function fanOut(event: ClaimedEvent) {
  const recipientIds = event.recipientIds ?? []
  if (recipientIds.length === 0) {
    await db.update(notificationOutbox).set({ status: 'DONE', processedAt: new Date() }).where(eq(notificationOutbox.id, event.id))
    return
  }

  // The caller names the recipients, so the society is checked here rather than trusted: a
  // notification about one society never reaches an account that belongs to another, whatever
  // list a service hands in. An inactive account is dropped the same way.
  const people = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(inArray(users.id, recipientIds), eq(users.isActive, true), eq(users.societyId, event.societyId)))

  const wantsEmail = EMAIL_EVENTS.includes(event.eventType)
  const pushable = await db
    .select({ userId: pushSubscriptions.userId })
    .from(pushSubscriptions)
    .where(and(inArray(pushSubscriptions.userId, recipientIds), eq(pushSubscriptions.isActive, true)))
  const hasPush = new Set(pushable.map((row) => row.userId))

  await db.transaction(async (tx) => {
    for (const person of people) {
      // onConflictDoNothing: a retried outbox row must not tell the same person twice
      const [record] = await tx
        .insert(notifications)
        .values({
          outboxId: event.id,
          userId: person.id,
          societyId: event.societyId,
          eventType: event.eventType,
          entityType: event.entityType,
          entityId: event.entityId,
          payload: event.payload,
        })
        .onConflictDoNothing()
        .returning({ id: notifications.id })
      if (!record) continue

      const channels: { channel: 'IN_APP' | 'SOCKET' | 'PUSH' | 'EMAIL'; status: 'SENT' | 'PENDING' | 'SKIPPED' }[] = [
        // The in-app record exists by virtue of the row above
        { channel: 'IN_APP', status: 'SENT' },
        { channel: 'SOCKET', status: 'PENDING' },
        { channel: 'PUSH', status: hasPush.has(person.id) ? 'PENDING' : 'SKIPPED' },
        { channel: 'EMAIL', status: wantsEmail && person.email ? 'PENDING' : 'SKIPPED' },
      ]
      await tx.insert(notificationDeliveries).values(
        channels.map(({ channel, status }) => ({
          notificationId: record.id,
          channel,
          status,
          ...(status === 'SENT' ? { sentAt: new Date() } : {}),
        })),
      )
    }
    await tx.update(notificationOutbox).set({ status: 'DONE', processedAt: new Date() }).where(eq(notificationOutbox.id, event.id))
  })
}

/** Takes up to BATCH deliveries whose next attempt is due. */
async function claimDeliveries() {
  const stale = sql.raw(`interval '${STALE_CLAIM_MINUTES} minutes'`)
  const rows = await db.execute(sql`
    with claimed as (
      select d.id from ${notificationDeliveries} d
      where d.status = 'PENDING' and d.next_attempt_at <= now()
        and (d.claimed_at is null or d.claimed_at < now() - ${stale})
      order by d.next_attempt_at
      limit ${BATCH}
      for update skip locked
    )
    update ${notificationDeliveries} d
      set claimed_at = now()
      from claimed
      where d.id = claimed.id
      returning d.id, d.notification_id as "notificationId", d.channel, d.attempts
  `)
  return rows.rows as unknown as ClaimedDelivery[]
}

async function markSent(id: string, status: 'SENT' | 'SKIPPED' = 'SENT') {
  await db
    .update(notificationDeliveries)
    .set({ status, sentAt: new Date(), claimedAt: null, lastError: null, updatedAt: new Date() })
    .where(eq(notificationDeliveries.id, id))
}

/**
 * Records a failed attempt and when to try again. After MAX_ATTEMPTS the channel is DEAD and left
 * alone: five failures over an hour and a half is a channel that is not coming back on its own,
 * and the in-app record is still there to be read.
 */
export function nextAttempt(attemptsSoFar: number, permanent = false) {
  const attempts = attemptsSoFar + 1
  // A provider that refused the message will refuse it again, so there is no point waiting
  const dead = permanent || attempts >= MAX_ATTEMPTS
  const waitSeconds = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)]!
  return { attempts, dead, waitSeconds }
}

async function markFailed(delivery: ClaimedDelivery, error: unknown) {
  const permanent = error instanceof ChannelError && error.permanent
  const { attempts, dead, waitSeconds: wait } = nextAttempt(delivery.attempts, permanent)
  await db
    .update(notificationDeliveries)
    .set({
      status: dead ? 'DEAD' : 'PENDING',
      attempts,
      claimedAt: null,
      nextAttemptAt: dead ? new Date() : new Date(Date.now() + wait * 1000),
      lastError: (error as Error).message?.slice(0, 200) ?? 'Unknown failure',
      updatedAt: new Date(),
    })
    .where(eq(notificationDeliveries.id, delivery.id))
}

/** Attempts one delivery on its own channel. */
async function attempt(delivery: ClaimedDelivery) {
  const [record] = await db
    .select({
      id: notifications.id,
      userId: notifications.userId,
      eventType: notifications.eventType,
      entityType: notifications.entityType,
      entityId: notifications.entityId,
      payload: notifications.payload,
      email: users.email,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(eq(notifications.id, delivery.notificationId))
  if (!record) return markSent(delivery.id, 'SKIPPED')

  const message = describe(record.eventType, (record.payload ?? {}) as Record<string, unknown>)

  if (delivery.channel === 'SOCKET') {
    // Live only: a person who is not connected reads the in-app record instead, so there is
    // nothing to retry and nothing failed
    emitToUser(record.userId, 'notification', {
      id: record.id,
      eventType: record.eventType,
      entityType: record.entityType,
      entityId: record.entityId,
      ...message,
    })
    return markSent(delivery.id)
  }

  if (delivery.channel === 'EMAIL') {
    if (!record.email) return markSent(delivery.id, 'SKIPPED')
    const { skipped } = await sendEmail(record.email, message.title, message.body)
    return markSent(delivery.id, skipped ? 'SKIPPED' : 'SENT')
  }

  if (delivery.channel === 'PUSH') {
    // A push is for a person who is not looking: the socket already told the open application,
    // and a lock-screen copy of what is on the screen is just noise.
    if (isConnected(record.userId)) return markSent(delivery.id, 'SKIPPED')
    const targets = await db
      .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth })
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, record.userId), eq(pushSubscriptions.isActive, true)))
    if (targets.length === 0) return markSent(delivery.id, 'SKIPPED')

    let delivered = 0
    for (const target of targets) {
      try {
        const { skipped } = await sendPush(target, { ...message, url: `/notifications` })
        if (!skipped) delivered += 1
      } catch (error) {
        if (error instanceof ChannelError && error.permanent) {
          // The browser threw this subscription away; stop pushing to it
          await db.update(pushSubscriptions).set({ isActive: false }).where(eq(pushSubscriptions.id, target.id))
          continue
        }
        throw error
      }
    }
    return markSent(delivery.id, delivered > 0 ? 'SENT' : 'SKIPPED')
  }

  return markSent(delivery.id)
}

/**
 * One pass: fan out what is waiting, then attempt the deliveries that are due.
 *
 * Returns what it did, which is what the tests assert on rather than waiting for a timer.
 */
export async function runDispatcherOnce() {
  const { fannedOut } = await fanOutPending()
  const { attempted } = await deliverDue()
  return { fannedOut, attempted }
}

/** Turns pending outbox rows into notifications and the delivery rows to attempt. */
export async function fanOutPending() {
  let fannedOut = 0
  for (const event of await claimOutbox()) {
    try {
      await fanOut(event)
      fannedOut += 1
    } catch (error) {
      logger.error({ err: error, outboxId: event.id }, 'Could not fan out a notification')
      const dead = event.attempts + 1 >= MAX_ATTEMPTS
      await db
        .update(notificationOutbox)
        .set({
          status: dead ? 'DEAD' : 'PENDING',
          claimedAt: null,
          lastError: (error as Error).message?.slice(0, 200) ?? 'Unknown failure',
        })
        .where(eq(notificationOutbox.id, event.id))
    }
  }
  return { fannedOut }
}

/** Attempts every delivery whose next attempt is due, each on its own channel. */
export async function deliverDue() {
  let attempted = 0
  for (const delivery of await claimDeliveries()) {
    try {
      await attempt(delivery)
    } catch (error) {
      await markFailed(delivery, error)
    }
    attempted += 1
  }
  return { attempted }
}

/**
 * Where a notification has got to: in the centre, out of the door, read, or out of attempts.
 *
 * Derived from the delivery rows rather than stored, so it cannot disagree with them. IN_APP is
 * left out of the question: it is SENT the moment the record exists, and every notification
 * would read DELIVERED from birth.
 */
export type NotificationLifecycle = 'CREATED' | 'DELIVERED' | 'READ' | 'DELIVERY_FAILED'

// notifications.id is written out rather than interpolated: drizzle renders the column of the
// query's own table unqualified, and a bare "id" inside the subquery binds to the delivery's own.
const outbound = (status: 'SENT' | 'DEAD') => sql<boolean>`exists (
  select 1 from notification_deliveries d
  where d.notification_id = notifications.id and d.channel <> 'IN_APP' and d.status = ${status}
)`

/** Unread count and the most recent notifications for one person. */
export async function listNotifications(userId: string, limit = 50) {
  const rows = await db
    .select({
      id: notifications.id,
      eventType: notifications.eventType,
      entityType: notifications.entityType,
      entityId: notifications.entityId,
      payload: notifications.payload,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      sent: outbound('SENT'),
      dead: outbound('DEAD'),
    })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(sql`${notifications.createdAt} desc`)
    .limit(limit)
  return rows.map((row) => ({
    id: row.id,
    eventType: row.eventType,
    entityType: row.entityType,
    entityId: row.entityId,
    payload: row.payload,
    ...describe(row.eventType, (row.payload ?? {}) as Record<string, unknown>),
    deliveryStatus: (row.readAt ? 'READ' : row.sent ? 'DELIVERED' : row.dead ? 'DELIVERY_FAILED' : 'CREATED') as NotificationLifecycle,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }))
}

/** Marks one notification, or every unread one, as read for this person only. */
export async function markRead(userId: string, id?: string) {
  const mine = eq(notifications.userId, userId)
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(id ? and(mine, eq(notifications.id, id), isNull(notifications.readAt)) : and(mine, isNull(notifications.readAt)))
    .returning({ id: notifications.id })
  return { marked: rows.length }
}

/** Only ever counts this person's own unread records. */
export async function unreadCount(userId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
  return row?.count ?? 0
}
