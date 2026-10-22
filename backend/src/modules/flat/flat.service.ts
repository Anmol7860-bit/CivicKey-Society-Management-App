import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { accessRequests, blocks, flatResidents, flatVehicles, flats, floors } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { assertFlatAccess, assertSameSociety, assertState, requireRecord, UUID } from '../access/scope.js'
import { recordAuditEvent, type AuditEventType, type DbExecutor } from '../audit/audit.service.js'
import type { AccessRequestBody, AddVehicleBody, DecideAccessRequestBody } from '../gate/gate.schemas.js'

function audit(executor: DbExecutor, ctx: AuthContext, eventType: AuditEventType, metadata: Record<string, unknown>) {
  return recordAuditEvent(executor, { eventType, actorUserId: ctx.userId, metadata })
}

const place = { number: flats.number, blockName: blocks.name, floorLabel: floors.floorLabel }

async function loadFlat(ctx: AuthContext, flatId: string) {
  const [row] = UUID.test(flatId)
    ? await db
        .select({ id: flats.id, societyId: blocks.societyId, status: flats.status, ...place })
        .from(flats)
        .innerJoin(blocks, eq(blocks.id, flats.blockId))
        .innerJoin(floors, eq(floors.id, flats.floorId))
        .where(eq(flats.id, flatId))
    : []
  return requireRecord(ctx, row, 'Flat')
}

async function myFlatIds(ctx: AuthContext) {
  const rows = await db
    .select({ flatId: flatResidents.flatId })
    .from(flatResidents)
    .where(
      and(
        eq(flatResidents.userId, ctx.userId),
        eq(flatResidents.verificationStatus, 'VERIFIED'),
        lte(flatResidents.startDate, sql`current_date`),
        or(isNull(flatResidents.endDate), gte(flatResidents.endDate, sql`current_date`)),
      ),
    )
  return rows.map((row) => row.flatId)
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export async function listMyVehicles(ctx: AuthContext) {
  const flatIds = await myFlatIds(ctx)
  if (flatIds.length === 0) return []
  return db
    .select()
    .from(flatVehicles)
    .where(and(inArray(flatVehicles.flatId, flatIds), eq(flatVehicles.status, 'ACTIVE')))
    .orderBy(desc(flatVehicles.createdAt))
}

export async function addVehicle(ctx: AuthContext, flatId: string, body: AddVehicleBody) {
  const flat = await loadFlat(ctx, flatId)
  await assertFlatAccess(ctx, flat.id, { write: true, scopePermission: 'USER_MANAGE' })
  try {
    const [row] = await db
      .insert(flatVehicles)
      .values({ ...body, flatId, societyId: flat.societyId, addedBy: ctx.userId })
      .returning()
    await audit(db, ctx, 'VEHICLE_ADDED', { flat: `${flat.blockName}-${flat.number}`, number: body.number })
    return row!
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code
    if (code === '23505') throw new AppError(409, 'ALREADY_EXISTS', 'This vehicle number is already registered in the society')
    throw error
  }
}

/** Vehicles are retired, never deleted, so an old gate log still reads correctly. */
export async function removeVehicle(ctx: AuthContext, id: string) {
  const [existing] = UUID.test(id) ? await db.select().from(flatVehicles).where(eq(flatVehicles.id, id)) : []
  const vehicle = await requireRecord(ctx, existing, 'Vehicle')
  await assertFlatAccess(ctx, vehicle.flatId, { write: true, scopePermission: 'USER_MANAGE' })
  assertState(vehicle.status === 'ACTIVE', 'This vehicle has already been removed')

  const [row] = await db.update(flatVehicles).set({ status: 'INACTIVE' }).where(eq(flatVehicles.id, id)).returning()
  await audit(db, ctx, 'VEHICLE_REMOVED', { vehicleId: id, number: vehicle.number })
  return row!
}

/** The guard's plate lookup: whose vehicle is this? */
export async function findVehicle(ctx: AuthContext, societyId: string, number: string) {
  await assertSameSociety(ctx, societyId)
  const [row] = await db
    .select({ vehicle: flatVehicles, flat: place })
    .from(flatVehicles)
    .innerJoin(flats, eq(flats.id, flatVehicles.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(floors, eq(floors.id, flats.floorId))
    .where(
      and(eq(flatVehicles.societyId, societyId), eq(flatVehicles.status, 'ACTIVE'), sql`upper(${flatVehicles.number}) = upper(${number})`),
    )
  return row ? { ...row.vehicle, flat: { ...row.flat, label: `${row.flat.blockName}-${row.flat.number}` } } : null
}

// ---------------------------------------------------------------------------
// Access requests: a household account, or a new daily help
// ---------------------------------------------------------------------------

export async function createAccessRequest(ctx: AuthContext, body: AccessRequestBody) {
  const flat = await loadFlat(ctx, body.flatId)
  await assertFlatAccess(ctx, flat.id, { write: true })
  const [row] = await db
    .insert(accessRequests)
    .values({ ...body, societyId: flat.societyId, requestedBy: ctx.userId })
    .returning()
  await audit(db, ctx, 'ACCESS_REQUEST_CREATED', { requestId: row!.id, kind: body.kind, flat: `${flat.blockName}-${flat.number}` })
  return row!
}

export async function listMyAccessRequests(ctx: AuthContext) {
  const flatIds = await myFlatIds(ctx)
  if (flatIds.length === 0) return []
  return db.select().from(accessRequests).where(inArray(accessRequests.flatId, flatIds)).orderBy(desc(accessRequests.createdAt)).limit(30)
}

/** The office's queue: what residents have asked for, newest first. */
export async function listAccessRequests(ctx: AuthContext, societyId: string, status?: 'PENDING' | 'APPROVED' | 'REJECTED') {
  await assertSameSociety(ctx, societyId)
  const rows = await db
    .select({ request: accessRequests, flat: place })
    .from(accessRequests)
    .innerJoin(flats, eq(flats.id, accessRequests.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(floors, eq(floors.id, flats.floorId))
    .where(and(eq(accessRequests.societyId, societyId), ...(status ? [eq(accessRequests.status, status)] : [])))
    .orderBy(desc(accessRequests.createdAt))
    .limit(100)
  return rows.map((row) => ({ ...row.request, flat: { ...row.flat, label: `${row.flat.blockName}-${row.flat.number}` } }))
}

/**
 * Approving records the decision only. Creating the account or the staff record is still a
 * deliberate act in Add user or Staff management, so nothing is created behind the Admin's back.
 */
export async function decideAccessRequest(ctx: AuthContext, id: string, body: DecideAccessRequestBody) {
  const [existing] = UUID.test(id) ? await db.select().from(accessRequests).where(eq(accessRequests.id, id)) : []
  const request = await requireRecord(ctx, existing, 'Request')
  await assertSameSociety(ctx, request.societyId)
  assertState(request.status === 'PENDING', 'This request has already been decided')

  const [row] = await db
    .update(accessRequests)
    .set({ status: body.status, decidedBy: ctx.userId, decidedAt: new Date(), decisionReason: body.reason ?? null })
    .where(and(eq(accessRequests.id, id), eq(accessRequests.status, 'PENDING')))
    .returning()
  assertState(Boolean(row), 'This request has already been decided')
  await audit(db, ctx, 'ACCESS_REQUEST_DECIDED', { requestId: id, kind: request.kind, decision: body.status })
  return row!
}
