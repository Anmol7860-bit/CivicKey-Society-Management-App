import { and, eq, lt } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { processedClientEvents, visits } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { parseOrThrow } from '../../middleware/validateBody.js'
import type { Permission } from '../access/permissions.js'
import { recordEntrySchema, registerVisitSchema } from '../gate/gate.schemas.js'
import * as gate from '../gate/gate.service.js'
import { z } from 'zod'
import { MAX_LOCAL_ATTEMPTS, type SyncBatchBody, type SyncEvent, type SyncEventType } from './sync.schemas.js'

/**
 * A claim left behind by a request that died mid-flight. Longer than any gate write takes, short
 * enough that a guard's next sync is not blocked for the rest of the shift.
 */
/** The guard must say why they let someone in without an approval; it goes on the review. */
const manualReason = z.string().trim().min(3, 'Give the reason').max(120)

const STALE_CLAIM_MS = 5 * 60 * 1000
/** A device clock this far out cannot be trusted to order anything; the office looks at it instead. */
const MAX_SKEW_MS = 24 * 60 * 60 * 1000

type ResultStatus = 'APPLIED' | 'DUPLICATE_IGNORED' | 'FAILED_RETRY' | 'REJECTED' | 'NEEDS_REVIEW'

export interface EventResult {
  clientEventId: string
  status: ResultStatus
  entityId: string | null
  /** The domain code for a refusal, or why a review is needed */
  code: string | null
  serverTs: string
}

/** Once an event has one of these, it is never applied again; the stored answer is replayed. */
const DECIDED = ['APPLIED', 'DUPLICATE_IGNORED', 'REJECTED', 'NEEDS_REVIEW'] as const

interface Operation {
  permission: Permission
  run(ctx: AuthContext, event: SyncEvent): Promise<string | null>
}

const operations: Record<SyncEventType, Operation> = {
  VISITOR_REGISTER: {
    permission: 'VISIT_REGISTER',
    async run(ctx, event) {
      const payload = parseOrThrow(registerVisitSchema, event.payload)
      const societyId = await gate.societyIdFor(ctx)
      const visit = await gate.registerVisit(ctx, societyId, payload, { clientEventId: event.clientEventId })
      return visit.id
    },
  },
  VISIT_ENTRY_RECORD: {
    permission: 'VISIT_ENTRY_RECORD',
    async run(ctx, event) {
      const { gateId } = parseOrThrow(recordEntrySchema, event.payload)
      const visit = await gate.recordEntry(ctx, visitId(event), gateId)
      return visit.id
    },
  },
  VISIT_EXIT: {
    permission: 'VISIT_EXIT',
    async run(ctx, event) {
      const visit = await gate.recordExit(ctx, visitId(event))
      return visit.id
    },
  },
  // The guard let an unannounced visitor in during an outage. Nobody approved it, so it is
  // recorded as a physical entry needing review, never as an approval.
  MANUAL_OFFLINE_ENTRY: {
    permission: 'VISIT_DECIDE',
    async run(ctx, event) {
      const { reason, ...rest } = parseOrThrow(registerVisitSchema.extend({ reason: manualReason }), event.payload)
      const societyId = await gate.societyIdFor(ctx)
      const visit = await gate.registerVisit(ctx, societyId, rest, {
        clientEventId: event.clientEventId,
        manualOffline: { reason, at: new Date(event.clientTs) },
      })
      return visit.id
    },
  },
}

function visitId(event: SyncEvent) {
  if (!event.entityId) throw new AppError(422, 'VALIDATION_ERROR', 'This event needs the visit it refers to')
  return event.entityId
}

function result(row: typeof processedClientEvents.$inferSelect, status?: ResultStatus): EventResult {
  return {
    clientEventId: row.clientEventId,
    status: status ?? (row.resultStatus as ResultStatus),
    entityId: row.entityId,
    code: row.resultCode,
    serverTs: row.serverTs.toISOString(),
  }
}

/** A failure the device should retry: the change rolled back, so the next attempt must be free to run. */
function retryable(error: unknown) {
  if (!(error instanceof AppError)) return true
  return error.status >= 500 || [408, 429].includes(error.status)
}

/**
 * Takes this event's id for this attempt, or hands back what is already stored.
 *
 * The INSERT is the lock: the primary key means only one request can hold an id. A claim left
 * IN_PROGRESS past STALE_CLAIM_MS is taken over, since the request holding it is gone. A row left
 * FAILED_RETRY is a previous attempt that rolled back, so it is retried.
 */
async function claim(ctx: AuthContext, event: SyncEvent) {
  const values = {
    clientEventId: event.clientEventId,
    userId: ctx.userId,
    deviceId: event.deviceId,
    operationType: event.eventType,
    clientTs: new Date(event.clientTs),
  }
  const [fresh] = await db.insert(processedClientEvents).values(values).onConflictDoNothing().returning()
  if (fresh) return { held: true as const }

  const [existing] = await db
    .select()
    .from(processedClientEvents)
    .where(eq(processedClientEvents.clientEventId, event.clientEventId))
  // Ids are generated per device; one turning up under another account is not a retry
  if (existing!.userId !== ctx.userId) {
    throw new AppError(403, 'PERMISSION_DENIED', 'That event was sent by another account')
  }
  if ((DECIDED as readonly string[]).includes(existing!.resultStatus)) {
    // An applied event replayed is a duplicate, and says so; a refusal or review replays as itself
    return { held: false as const, row: existing!, status: existing!.resultStatus === 'APPLIED' ? ('DUPLICATE_IGNORED' as const) : undefined }
  }

  const retryClaim = and(
    eq(processedClientEvents.clientEventId, event.clientEventId),
    existing!.resultStatus === 'FAILED_RETRY'
      ? eq(processedClientEvents.resultStatus, 'FAILED_RETRY')
      : and(eq(processedClientEvents.resultStatus, 'IN_PROGRESS'), lt(processedClientEvents.claimedAt, new Date(Date.now() - STALE_CLAIM_MS))),
  )
  const [reclaimed] = await db
    .update(processedClientEvents)
    .set({ resultStatus: 'IN_PROGRESS', claimedAt: new Date(), deviceId: event.deviceId, operationType: event.eventType })
    .where(retryClaim)
    .returning()
  if (reclaimed) return { held: true as const }
  // Another request is applying it right now; the device sends it again rather than giving up
  return { held: false as const, row: existing!, status: 'FAILED_RETRY' as const }
}

async function finalize(clientEventId: string, status: ResultStatus, changes: { entityId?: string | null; code?: string | null } = {}) {
  const [row] = await db
    .update(processedClientEvents)
    .set({
      resultStatus: status,
      serverTs: new Date(),
      entityId: changes.entityId ?? null,
      resultCode: changes.code ?? null,
      resultPayload: { status, ...changes },
    })
    .where(eq(processedClientEvents.clientEventId, clientEventId))
    .returning()
  return result(row!)
}

/** Applies one event, exactly once, in its own transaction. Never throws: the batch continues. */
async function applyOne(ctx: AuthContext, event: SyncEvent): Promise<EventResult> {
  const serverTs = new Date().toISOString()
  const refuse = (status: ResultStatus, code: string): EventResult => ({ clientEventId: event.clientEventId, status, entityId: event.entityId ?? null, code, serverTs })

  const operation = operations[event.eventType]
  if (!ctx.permissions?.includes(operation.permission)) return refuse('REJECTED', 'PERMISSION_DENIED')

  let held: Awaited<ReturnType<typeof claim>>
  try {
    held = await claim(ctx, event)
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR'
    return refuse(retryable(error) ? 'FAILED_RETRY' : 'REJECTED', code)
  }
  if (!held.held) return result(held.row, held.status)

  // The device has given up deciding: the office resolves it, and nothing is applied automatically
  if (event.localAttemptCount >= MAX_LOCAL_ATTEMPTS) return finalize(event.clientEventId, 'NEEDS_REVIEW', { code: 'RETRY_LIMIT_REACHED' })
  if (Math.abs(Date.now() - Date.parse(event.clientTs)) > MAX_SKEW_MS) {
    return finalize(event.clientEventId, 'NEEDS_REVIEW', { code: 'CLOCK_SKEW' })
  }

  // A reclaimed claim may be a second run of a registration that already committed
  if (event.eventType === 'VISITOR_REGISTER' || event.eventType === 'MANUAL_OFFLINE_ENTRY') {
    const [already] = await db.select({ id: visits.id }).from(visits).where(eq(visits.clientEventId, event.clientEventId))
    if (already) return finalize(event.clientEventId, 'DUPLICATE_IGNORED', { entityId: already.id })
  }

  try {
    return await finalize(event.clientEventId, 'APPLIED', { entityId: await operation.run(ctx, event) })
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR'
    // FAILED_RETRY is kept, not deleted: the office can see a device stuck on one event
    return finalize(event.clientEventId, retryable(error) ? 'FAILED_RETRY' : 'REJECTED', { code, entityId: event.entityId ?? null })
  }
}

/**
 * Drains one batch from a guard's device. Events are applied in the order the device recorded
 * them, each on its own, so one refusal never blocks the rest.
 */
export async function applyBatch(ctx: AuthContext, body: SyncBatchBody) {
  // A guard with no society cannot record anything, and the gate check needs one
  await gate.societyIdFor(ctx)
  const ordered = [...body.events].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.clientTs.localeCompare(b.clientTs))

  const results: EventResult[] = []
  for (const event of ordered) results.push(await applyOne(ctx, event))
  return { batchId: body.batchId, results }
}

/** What the office resolves: events a device could not get applied. */
export async function listForReview(ctx: AuthContext) {
  await gate.societyIdFor(ctx)
  const rows = await db
    .select()
    .from(processedClientEvents)
    .where(and(eq(processedClientEvents.resultStatus, 'NEEDS_REVIEW')))
  return rows.map((row) => result(row))
}
