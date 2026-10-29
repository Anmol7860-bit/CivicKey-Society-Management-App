import { and, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { blocks, flats, invoices, communityTasks, notificationOutbox, societySettings, visits } from '../../db/schema.js'
import { logger } from '../../lib/logger.js'
import { renderPendingReceipts } from '../billing/receipt.service.js'
import { recordAuditEvent } from '../audit/audit.service.js'
import { deleteStoredFile } from '../file/file.service.js'
import { approverFor, effectiveApprover } from '../gate/gate.service.js'
import { enqueueNotification } from './outbox.service.js'

/**
 * Work that happens because time passed rather than because someone pressed something.
 *
 * Every job asks the database what is due, using the database's own clock and its own columns.
 * Nothing is held in a process timer: a restart in the middle of a shift would forget it, and two
 * API instances would each run their own.
 */

const flatLabel = sql<string>`${blocks.name} || '-' || ${flats.number}`

/**
 * The approver gets exactly one reminder, at reminder_at.
 *
 * The update that marks the reminder sent is also the claim: a row whose reminder_sent_at is
 * already set is not picked up again, so two dispatchers cannot both send it.
 */
async function sendApprovalReminders() {
  // The claim and the events it owes commit together: a reminder stamped but never enqueued
  // would be a reminder nobody ever gets.
  return db.transaction(async (tx) => {
    const due = await tx
      .update(visits)
      .set({ reminderSentAt: new Date() })
      .where(
        and(
          eq(visits.status, 'AWAITING_APPROVAL'),
          isNull(visits.reminderSentAt),
          lte(visits.reminderAt, sql`now()`),
        ),
      )
      .returning({
        id: visits.id,
        societyId: visits.societyId,
        flatId: visits.flatId,
        visitorName: visits.visitorName,
        intendedResidentId: visits.intendedResidentId,
      })

    for (const visit of due) {
      // The reminder follows the first notice: the resident the visitor asked for, when there is one
      const approver = await approverFor(visit.flatId, visit.intendedResidentId)
      if (!approver) continue
      const recipient = approver.userId
      await enqueueNotification(tx, {
        societyId: visit.societyId,
        eventType: 'VISITOR_APPROVAL_REMINDER',
        entityType: 'visit',
        entityId: visit.id,
        recipientIds: [recipient],
        payload: { name: visit.visitorName, flat: await labelFor(visit.flatId) },
      })
    }
    return due.length
  })
}

/**
 * A visit nobody answered by escalate_at becomes the guard's to decide.
 *
 * The status change is the claim, for the same reason as above: only the update that actually
 * moved the row out of AWAITING_APPROVAL returns it.
 */
async function escalateUnanswered() {
  return db.transaction(async (tx) => {
    const due = await tx
      .update(visits)
      .set({ status: 'AWAITING_MANUAL', updatedAt: new Date() })
      .where(and(eq(visits.status, 'AWAITING_APPROVAL'), lte(visits.escalateAt, sql`now()`)))
      .returning({ id: visits.id, societyId: visits.societyId, flatId: visits.flatId, visitorName: visits.visitorName, registeredBy: visits.registeredBy })

    for (const visit of due) {
      // The guard at the gate is told, because the decision is now theirs to make
      await enqueueNotification(tx, {
        societyId: visit.societyId,
        eventType: 'VISITOR_ESCALATED_TO_GATE',
        entityType: 'visit',
        entityId: visit.id,
        recipientIds: visit.registeredBy ? [visit.registeredBy] : [],
        payload: { name: visit.visitorName, flat: await labelFor(visit.flatId) },
      })
    }
    return due.length
  })
}

async function labelFor(flatId: string) {
  const [row] = await db
    .select({ label: flatLabel })
    .from(flats)
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .where(eq(flats.id, flatId))
  return row?.label ?? 'the flat'
}

/** A task's one reminder a day before it is due, and one notice once it is late. */
async function taskDeadlines() {
  return db.transaction(async (tx) => {
    const soon = await tx
      .update(communityTasks)
      .set({ dueReminderSentAt: new Date() })
      .where(
        and(
          isNull(communityTasks.dueReminderSentAt),
          sql`${communityTasks.dueDate} is not null`,
          lte(communityTasks.dueDate, sql`current_date + 1`),
          sql`${communityTasks.status} not in ('DONE','CANCELLED')`,
        ),
      )
      .returning({ id: communityTasks.id, societyId: communityTasks.societyId, title: communityTasks.title, raisedBy: communityTasks.raisedBy })

    const late = await tx
      .update(communityTasks)
      .set({ overdueNoticeSentAt: new Date() })
      .where(
        and(
          isNull(communityTasks.overdueNoticeSentAt),
          sql`${communityTasks.dueDate} is not null`,
          lte(communityTasks.dueDate, sql`current_date`),
          sql`${communityTasks.status} not in ('DONE','CANCELLED')`,
        ),
      )
      .returning({ id: communityTasks.id, societyId: communityTasks.societyId, title: communityTasks.title, raisedBy: communityTasks.raisedBy })

    for (const [eventType, rows] of [['TASK_DUE_SOON', soon], ['TASK_OVERDUE', late]] as const) {
      for (const task of rows) {
        // The assignee is a staff record with no login, so the person who raised it is told
        if (!task.raisedBy) continue
        await enqueueNotification(tx, {
          societyId: task.societyId,
          eventType,
          entityType: 'task',
          entityId: task.id,
          recipientIds: [task.raisedBy],
          payload: { title: task.title },
        })
      }
    }
    return soon.length + late.length
  })
}

/**
 * Bills: a notice three days before the due date, and on days 1, 7 and 15 after it.
 *
 * The notice days are fixed, and each one is sent once because the outbox is checked for an
 * identical event on the same day before a new one is written.
 */
/**
 * Calls an unpaid invoice OVERDUE once its due date has passed.
 *
 * A report and a reminder should not disagree about whether a bill is late, so lateness is a
 * stored status rather than a date comparison repeated in every query.
 */
async function markOverdue() {
  const late = await db
    .update(invoices)
    .set({ status: 'OVERDUE', updatedAt: new Date() })
    .where(and(eq(invoices.status, 'UNPAID'), sql`${invoices.dueDate} < current_date`))
    .returning({ id: invoices.id })
  return late.length
}

async function billReminders() {
  const rows = await db
    .select({
      id: invoices.id,
      societyId: invoices.societyId,
      flatId: invoices.flatId,
      dueDate: invoices.dueDate,
      status: invoices.status,
      label: flatLabel,
      daysPastDue: sql<number>`(current_date - ${invoices.dueDate})::int`,
    })
    .from(invoices)
    .innerJoin(flats, eq(flats.id, invoices.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .where(
      and(
        sql`${invoices.status} in ('UNPAID','OVERDUE','PARTIALLY_PAID')`,
        sql`(current_date - ${invoices.dueDate})::int in (-3, 1, 7, 15)`,
      ),
    )

  let sent = 0
  for (const invoice of rows) {
    const eventType = invoice.daysPastDue < 0 ? 'BILL_DUE_SOON' : 'BILL_OVERDUE'
    // One notice per invoice per day, however many times the job runs today
    const [already] = await db
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.entityId, invoice.id),
          eq(notificationOutbox.eventType, eventType),
          sql`${notificationOutbox.createdAt} >= current_date`,
        ),
      )
    if (already) continue

    const approver = await effectiveApprover(invoice.flatId)
    if (!approver) continue
    // The bare handle on purpose: the notice is the only write, so there is no change to commit
    // with. The same-day check above is what keeps a second run from repeating it.
    await enqueueNotification(db, {
      societyId: invoice.societyId,
      eventType,
      entityType: 'invoice',
      entityId: invoice.id,
      recipientIds: [approver.userId],
      payload: { flat: invoice.label, dueDate: invoice.dueDate },
    })
    sent += 1
  }
  return sent
}

/** One pass of every scheduled job. Returns what each did, which is what the tests assert on. */
/**
 * Deletes visitor photographs once the society's retention period has passed.
 *
 * A photograph is personal data with no reason to outlive the visit it belonged to. The visit row,
 * its times and its audit trail all stay: only the image goes, and the deletion is itself audited
 * so the record shows a photo was removed rather than never taken.
 */
async function deleteExpiredPhotos() {
  const over = ['CLOSED', 'CANCELLED', 'DENIED', 'REJECTED_AT_GATE', 'LEAVE_AT_GATE'] as const
  const due = await db
    .select({ id: visits.id, societyId: visits.societyId, photoReference: visits.photoReference })
    .from(visits)
    .leftJoin(societySettings, eq(societySettings.societyId, visits.societyId))
    .where(
      and(
        isNotNull(visits.photoReference),
        inArray(visits.status, over),
        // Closed long enough ago by this society's own rule, with the shipped default behind it
        lte(visits.updatedAt, sql`now() - make_interval(days => coalesce(${societySettings.photoRetentionDays}, 90))`),
      ),
    )
    .limit(200)

  let deleted = 0
  for (const visit of due) {
    // The reference is cleared first: a row pointing at a file that is gone is the worse of the
    // two half-states, and a file left behind is picked up on the next tick.
    await db.update(visits).set({ photoReference: null, updatedAt: new Date() }).where(eq(visits.id, visit.id))
    await deleteStoredFile(visit.photoReference!)
    await recordAuditEvent(db, {
      eventType: 'VISIT_PHOTO_DELETED',
      actorUserId: null,
      metadata: { visitId: visit.id, societyId: visit.societyId, reason: 'retention' },
    })
    deleted += 1
  }
  return deleted
}

export async function runJobsOnce() {
  const results = { reminders: 0, escalations: 0, tasks: 0, overdue: 0, bills: 0, receipts: 0, photos: 0 }
  const steps = [
    ['reminders', sendApprovalReminders],
    ['escalations', escalateUnanswered],
    ['tasks', taskDeadlines],
    // Lateness is decided before the reminders go out, so they agree with the invoice's status
    ['overdue', markOverdue],
    ['bills', billReminders],
    ['receipts', renderPendingReceipts],
    ['photos', deleteExpiredPhotos],
  ] as const

  // Each job is independent: one failing must not stop the others from running this tick
  for (const [name, run] of steps) {
    try {
      results[name] = await run()
    } catch (error) {
      logger.error({ err: error, job: name }, 'A scheduled job failed')
    }
  }
  return results
}
