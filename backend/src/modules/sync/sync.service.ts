import { and, eq, lt } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { processedClientEvents, visits } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { parseOrThrow } from '../../middleware/validateBody.js'
import type { Permission } from '../access/permissions.js'
import * as gate from '../gate/gate.service.js'
import { recordEntrySchema, registerVisitSchema } from '../gate/gate.schemas.js'
import type { SyncEventBody, SyncOperation } from './sync.schemas.js'

/**
 * A claim left behind by a request that died mid-flight. Longer than any gate write takes, short
 * enough that a guard's next retry is not blocked for the rest of the shift.
 */
const STALE_CLAIM_MS = 5 * 60 * 1000
/** A device clock this far out cannot be trusted to order anything; the office looks at it instead. */
const MAX_SKEW_MS = 24 * 60 * 60 * 1000

type Outcome = { entityId: string | null }

interface Operation {
  permission: Permission
  run(ctx: AuthContext, body: SyncEventBody): Promise<Outcome>
}

const operations: Record<SyncOperation, Operation> = {
  VISITOR_REGISTER: {
    permission: 'VISIT_REGISTER',
    async run(ctx, body) {
      const payload = parseOrThrow(registerVisitSchema, body.payload)
      const societyId = await gate.societyIdFor(ctx)
      const visit = await gate.registerVisit(ctx, societyId, payload, body.clientEventId)
      return { entityId: visit.id }
    },
  },
  VISIT_ENTRY_RECORD: {
    permission: 'VISIT_ENTRY_RECORD',
    async run(ctx, body) {
      const { gateId } = parseOrThrow(recordEntrySchema, body.payload)
      const visit = await gate.recordEntry(ctx, visitId(body), gateId)
      return { entityId: visit.id }
    },
  },
  VISIT_EXIT: {
    permission: 'VISIT_EXIT',
    async run(ctx, body) {
      const visit = await gate.recordExit(ctx, visitId(body))
      return { entityId: visit.id }
    },
  },
}

function visitId(body: SyncEventBody) {
  if (!body.entityId) throw new AppError(422, 'VALIDATION_ERROR', 'This event needs the visit it refers to')
  return body.entityId
}

function serialize(row: typeof processedClientEvents.$inferSelect) {
  return {
    clientEventId: row.clientEventId,
    operationType: row.operationType,
    status: row.resultStatus,
    entityId: row.entityId,
    resultCode: row.resultCode,
    serverTs: row.serverTs.toISOString(),
  }
}

/**
 * Takes the event's id for this request, or reports that someone already has it.
 *
 * The INSERT is the lock: the primary key means only one request can claim an id. A claim left
 * IN_PROGRESS past STALE_CLAIM_MS is taken over, since the request holding it is gone.
 */
async function claim(ctx: AuthContext, body: SyncEventBody) {
  const [fresh] = await db
    .insert(processedClientEvents)
    .values({
      clientEventId: body.clientEventId,
      userId: ctx.userId,
      operationType: body.operationType,
      clientTs: new Date(body.clientTs),
    })
    .onConflictDoNothing()
    .returning()
  if (fresh) return { held: true as const }

  const [existing] = await db
    .select()
    .from(processedClientEvents)
    .where(eq(processedClientEvents.clientEventId, body.clientEventId))
  // Ids are generated per device; one turning up under another account is not a retry
  if (existing!.userId !== ctx.userId) {
    throw new AppError(403, 'PERMISSION_DENIED', 'That event was sent by another account')
  }
  if (existing!.resultStatus !== 'IN_PROGRESS') return { held: false as const, row: existing! }

  const [reclaimed] = await db
    .update(processedClientEvents)
    .set({ claimedAt: new Date(), operationType: body.operationType })
    .where(
      and(
        eq(processedClientEvents.clientEventId, body.clientEventId),
        eq(processedClientEvents.resultStatus, 'IN_PROGRESS'),
        lt(processedClientEvents.claimedAt, new Date(Date.now() - STALE_CLAIM_MS)),
      ),
    )
    .returning()
  if (reclaimed) return { held: true as const }
  // Another request is applying it right now. 503 so the device retries instead of giving up.
  throw new AppError(503, 'SYNC_IN_PROGRESS', 'That event is still being processed')
}

async function finalize(
  clientEventId: string,
  resultStatus: 'APPLIED' | 'DUPLICATE_IGNORED' | 'REJECTED' | 'NEEDS_REVIEW',
  changes: { entityId?: string | null; resultCode?: string | null } = {},
) {
  const [row] = await db
    .update(processedClientEvents)
    .set({ resultStatus, serverTs: new Date(), ...changes })
    .where(eq(processedClientEvents.clientEventId, clientEventId))
    .returning()
  return serialize(row!)
}

/** A failure the device should retry: the change rolled back, so the claim must not survive it. */
function retryable(error: unknown) {
  if (!(error instanceof AppError)) return true
  return error.status >= 500 || [408, 429].includes(error.status)
}

/**
 * Applies one queued event, exactly once. An id already decided is answered from the ledger
 * without touching the gate again, which is what lets the device retry after a lost response.
 */
export async function applyEvent(ctx: AuthContext, body: SyncEventBody) {
  const operation = operations[body.operationType]
  if (!ctx.permissions?.includes(operation.permission)) {
    throw new AppError(403, 'PERMISSION_DENIED', 'You cannot record that at the gate')
  }

  const held = await claim(ctx, body)
  if (!held.held) return serialize(held.row)

  if (Math.abs(Date.now() - Date.parse(body.clientTs)) > MAX_SKEW_MS) {
    return finalize(body.clientEventId, 'NEEDS_REVIEW', { resultCode: 'CLOCK_SKEW' })
  }

  // A reclaimed stale claim may be a second run of a registration that already committed
  if (body.operationType === 'VISITOR_REGISTER') {
    const [already] = await db.select({ id: visits.id }).from(visits).where(eq(visits.clientEventId, body.clientEventId))
    if (already) return finalize(body.clientEventId, 'DUPLICATE_IGNORED', { entityId: already.id })
  }

  try {
    const { entityId } = await operation.run(ctx, body)
    return await finalize(body.clientEventId, 'APPLIED', { entityId })
  } catch (error) {
    if (retryable(error)) {
      // Nothing was decided, so leave no claim behind to block the retry
      await db.delete(processedClientEvents).where(eq(processedClientEvents.clientEventId, body.clientEventId))
      throw error
    }
    const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR'
    await finalize(body.clientEventId, 'REJECTED', { resultCode: code, entityId: body.entityId ?? null })
    throw error
  }
}

