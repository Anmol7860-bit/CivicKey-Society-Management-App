import { and, asc, eq, gte, isNull, or, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { blocks, flatResidents, flats, floors, societies } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { assertState, requireRecord, UUID } from '../access/scope.js'
import { recordAuditEvent, type AuditEventType, type DbExecutor } from '../audit/audit.service.js'
import type {
  CreateBlockBody,
  CreateFlatBody,
  CreateFloorBody,
  UpdateBlockBody,
  UpdateFlatBody,
  UpdateFloorBody,
  UpdateSocietyBody,
} from './society.schemas.js'

// Locking: a write takes FOR UPDATE on the row it changes and FOR SHARE on the parent it checks is
// active, so deactivating a parent and adding or reactivating a child under it cannot interleave.
type Lock = 'update' | 'share'

/** Maps a unique-constraint violation, including one lost to a concurrent insert, to 409. */
async function unique<T>(write: PromiseLike<T>, message: string) {
  try {
    return await write
  } catch (error) {
    const pgError = error as { code?: string; cause?: { code?: string } }
    if ((pgError.code ?? pgError.cause?.code) === '23505') throw new AppError(409, 'ALREADY_EXISTS', message)
    throw error
  }
}

function audit(tx: DbExecutor, ctx: AuthContext, eventType: AuditEventType, metadata: Record<string, unknown>) {
  return recordAuditEvent(tx, { eventType, actorUserId: ctx.userId, metadata })
}

// Loaders: 404 for a missing or malformed id, 403 CROSS_SOCIETY_ACCESS outside the Admin's society

async function loadSociety(executor: DbExecutor, ctx: AuthContext, id: string, lock?: Lock) {
  let query = executor.select().from(societies).where(eq(societies.id, id)).$dynamic()
  if (lock) query = query.for(lock)
  const [row] = UUID.test(id) ? await query : []
  await requireRecord(ctx, row && { societyId: row.id }, 'Society')
  return row!
}

async function loadBlock(executor: DbExecutor, ctx: AuthContext, id: string, lock?: Lock) {
  let query = executor.select().from(blocks).where(eq(blocks.id, id)).$dynamic()
  if (lock) query = query.for(lock)
  const [row] = UUID.test(id) ? await query : []
  return requireRecord(ctx, row, 'Block')
}

async function loadFloor(executor: DbExecutor, ctx: AuthContext, id: string, lock?: Lock) {
  let query = executor
    .select({ floor: floors, societyId: blocks.societyId })
    .from(floors)
    .innerJoin(blocks, eq(blocks.id, floors.blockId))
    .where(eq(floors.id, id))
    .$dynamic()
  if (lock) query = query.for(lock, { of: floors })
  const [row] = UUID.test(id) ? await query : []
  return requireRecord(ctx, row && { ...row.floor, societyId: row.societyId }, 'Floor')
}

async function loadFlat(executor: DbExecutor, ctx: AuthContext, id: string, lock?: Lock) {
  let query = executor.select().from(flats).where(eq(flats.id, id)).$dynamic()
  if (lock) query = query.for(lock)
  const [row] = UUID.test(id) ? await query : []
  return requireRecord(ctx, row, 'Flat')
}

// ---------------------------------------------------------------------------
// Societies
// ---------------------------------------------------------------------------

/** An Admin manages only the society their account belongs to. */
export function listSocieties(ctx: AuthContext) {
  if (!ctx.societyId) return []
  return db.select().from(societies).where(eq(societies.id, ctx.societyId))
}

export const getSociety = (ctx: AuthContext, id: string) => loadSociety(db, ctx, id)

export function updateSociety(ctx: AuthContext, id: string, body: UpdateSocietyBody) {
  return db.transaction(async (tx) => {
    await loadSociety(tx, ctx, id, 'update')
    const [society] = await tx
      .update(societies)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(societies.id, id))
      .returning()
    await audit(tx, ctx, 'SOCIETY_UPDATED', { societyId: id, changes: body })
    return society!
  })
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const duplicateBlock = 'A block with this name already exists in this society'

export async function listBlocks(ctx: AuthContext, societyId: string) {
  await loadSociety(db, ctx, societyId)
  return db.select().from(blocks).where(eq(blocks.societyId, societyId)).orderBy(sql`lower(${blocks.name})`)
}

export function createBlock(ctx: AuthContext, societyId: string, body: CreateBlockBody) {
  return db.transaction(async (tx) => {
    await loadSociety(tx, ctx, societyId, 'share')
    const [block] = await unique(tx.insert(blocks).values({ societyId, name: body.name }).returning(), duplicateBlock)
    await audit(tx, ctx, 'BLOCK_CREATED', { societyId, blockId: block!.id, name: block!.name })
    return block!
  })
}

/** Renames or (de)activates a block. Its floors and flats are not touched. */
export function updateBlock(ctx: AuthContext, blockId: string, body: UpdateBlockBody) {
  return db.transaction(async (tx) => {
    const block = await loadBlock(tx, ctx, blockId, 'update')
    if (body.isActive === false && block.isActive) {
      // An active flat always sits on an active floor, so checking floors covers flats too
      const activeFloors = await tx.$count(floors, and(eq(floors.blockId, blockId), eq(floors.isActive, true)))
      assertState(activeFloors === 0, 'Deactivate the floors in this block first')
    }
    const [updated] = await unique(
      tx.update(blocks).set({ ...body, updatedAt: new Date() }).where(eq(blocks.id, blockId)).returning(),
      duplicateBlock,
    )
    await audit(tx, ctx, 'BLOCK_UPDATED', { societyId: block.societyId, blockId, changes: body })
    return updated!
  })
}

// ---------------------------------------------------------------------------
// Floors
// ---------------------------------------------------------------------------

const duplicateFloor = 'A floor with this label already exists in this block'
const inactiveBlock = 'This block is inactive, so it cannot have active floors'

export async function listFloors(ctx: AuthContext, blockId: string) {
  await loadBlock(db, ctx, blockId)
  return db
    .select()
    .from(floors)
    .where(eq(floors.blockId, blockId))
    .orderBy(sql`${floors.displayOrder} asc nulls last`, sql`lower(${floors.label})`)
}

export function createFloor(ctx: AuthContext, blockId: string, body: CreateFloorBody) {
  return db.transaction(async (tx) => {
    const block = await loadBlock(tx, ctx, blockId, 'share')
    assertState(block.isActive, inactiveBlock)
    const [floor] = await unique(
      tx.insert(floors).values({ blockId, label: body.label, displayOrder: body.displayOrder ?? null }).returning(),
      duplicateFloor,
    )
    await audit(tx, ctx, 'FLOOR_CREATED', { societyId: block.societyId, blockId, floorId: floor!.id, label: floor!.label })
    return floor!
  })
}

export function updateFloor(ctx: AuthContext, floorId: string, body: UpdateFloorBody) {
  return db.transaction(async (tx) => {
    const floor = await loadFloor(tx, ctx, floorId, 'update')
    if (body.isActive === false && floor.isActive) {
      const activeFlats = await tx.$count(flats, and(eq(flats.floorId, floorId), eq(flats.isActive, true)))
      assertState(activeFlats === 0, 'Deactivate or move the flats on this floor first')
    }
    if (body.isActive === true && !floor.isActive) {
      assertState((await loadBlock(tx, ctx, floor.blockId, 'share')).isActive, inactiveBlock)
    }
    const [updated] = await unique(
      tx.update(floors).set({ ...body, updatedAt: new Date() }).where(eq(floors.id, floorId)).returning(),
      duplicateFloor,
    )
    await audit(tx, ctx, 'FLOOR_UPDATED', { societyId: floor.societyId, blockId: floor.blockId, floorId, changes: body })
    return updated!
  })
}

// ---------------------------------------------------------------------------
// Flats
// ---------------------------------------------------------------------------

const duplicateFlat = 'A flat with this number already exists in this block'
const inactiveFloor = 'This floor is inactive, so it cannot have active flats'

export async function listFlats(ctx: AuthContext, floorId: string) {
  await loadFloor(db, ctx, floorId)
  return db.select().from(flats).where(eq(flats.floorId, floorId)).orderBy(asc(flats.number))
}

/** The flat's block and society are taken from the floor, never from the request. */
export function createFlat(ctx: AuthContext, floorId: string, body: CreateFlatBody) {
  return db.transaction(async (tx) => {
    const floor = await loadFloor(tx, ctx, floorId, 'share')
    assertState(floor.isActive, inactiveFloor)
    const [flat] = await unique(
      tx.insert(flats).values({ societyId: floor.societyId, blockId: floor.blockId, floorId, number: body.number }).returning(),
      duplicateFlat,
    )
    await audit(tx, ctx, 'FLAT_CREATED', { societyId: floor.societyId, flatId: flat!.id, floorId, number: flat!.number })
    return flat!
  })
}

export async function getFlat(ctx: AuthContext, flatId: string) {
  const query = db
    .select({
      flat: flats,
      block: { id: blocks.id, name: blocks.name, isActive: blocks.isActive },
      floor: { id: floors.id, label: floors.label, isActive: floors.isActive },
    })
    .from(flats)
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(floors, eq(floors.id, flats.floorId))
    .where(eq(flats.id, flatId))
  const [row] = UUID.test(flatId) ? await query : []
  const flat = await requireRecord(ctx, row?.flat, 'Flat')
  return { ...flat, block: row!.block, floor: row!.floor }
}

export function updateFlat(ctx: AuthContext, flatId: string, body: UpdateFlatBody) {
  return db.transaction(async (tx) => {
    const flat = await loadFlat(tx, ctx, flatId, 'update')
    const moving = body.floorId !== undefined && body.floorId !== flat.floorId
    const target = moving ? await loadFloor(tx, ctx, body.floorId!, 'share') : undefined
    if (target) assertState(target.isActive, inactiveFloor)

    if (body.isActive === false && flat.isActive) {
      // Includes links starting later, so a booked move-in is not orphaned
      const residents = await tx.$count(
        flatResidents,
        and(eq(flatResidents.flatId, flatId), or(isNull(flatResidents.endDate), gte(flatResidents.endDate, sql`current_date`))),
      )
      assertState(residents === 0, 'End the current and upcoming resident links for this flat first')
    }
    if (body.isActive === true && !flat.isActive && !target) {
      assertState((await loadFloor(tx, ctx, flat.floorId, 'share')).isActive, inactiveFloor)
    }

    const [updated] = await unique(
      tx
        .update(flats)
        .set({ number: body.number, isActive: body.isActive, floorId: target?.id, blockId: target?.blockId, updatedAt: new Date() })
        .where(eq(flats.id, flatId))
        .returning(),
      duplicateFlat,
    )
    await audit(tx, ctx, 'FLAT_UPDATED', { societyId: flat.societyId, flatId, changes: body })
    return updated!
  })
}
