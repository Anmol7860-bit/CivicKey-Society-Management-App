import { and, asc, count, eq, gte, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { blocks, flatResidents, flats, floors, gates, societies, users } from '../../db/schema.js'
import { AppError, type ErrorCode } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { assertState, requireRecord, UUID } from '../access/scope.js'
import { recordAuditEvent, type AuditEventType, type DbExecutor } from '../audit/audit.service.js'
import type {
  CreateBlockBody,
  CreateFlatBody,
  CreateFloorBody,
  CreateGateBody,
  UpdateGateBody,
  UpdateBlockBody,
  UpdateFlatBody,
  UpdateFloorBody,
  UpdateSocietyBody,
} from './society.schemas.js'

const ACTIVE = 'ACTIVE'
const INACTIVE = 'INACTIVE'

// Locking: a write takes FOR UPDATE on the row it changes and FOR SHARE on the parent it checks is
// active, so deactivating a parent and adding or reactivating a child under it cannot interleave.
type Lock = 'update' | 'share'

/** Maps a unique-constraint violation, including one lost to a concurrent insert, to 409. */
async function unique<T>(write: PromiseLike<T>, [code, message]: readonly [ErrorCode, string]) {
  try {
    return await write
  } catch (error) {
    const pgError = error as { code?: string; cause?: { code?: string } }
    if ((pgError.code ?? pgError.cause?.code) === '23505') throw new AppError(409, code, message)
    throw error
  }
}

/** 409 when deactivating would leave active children behind. */
function assertNoChildren(none: boolean, message: string) {
  if (!none) throw new AppError(409, 'RESOURCE_HAS_CHILDREN', message)
}

function audit(tx: DbExecutor, ctx: AuthContext, eventType: AuditEventType, metadata: Record<string, unknown>) {
  return recordAuditEvent(tx, { eventType, actorUserId: ctx.userId, metadata })
}

/**
 * Verified assignments that have not ended. The sharing cap counts tenants only: an owner or
 * co-owner never takes a slot, so a landlord living elsewhere does not fill their own flat.
 */
export async function countOccupants(tx: DbExecutor, flatId: string) {
  const [row] = await tx
    .select({
      occupants: count(),
      tenants: count(sql`case when ${flatResidents.residentType} = 'TENANT' then 1 end`),
    })
    .from(flatResidents)
    .where(
      and(
        eq(flatResidents.flatId, flatId),
        eq(flatResidents.verificationStatus, 'VERIFIED'),
        or(isNull(flatResidents.endDate), gte(flatResidents.endDate, sql`current_date`)),
      ),
    )
  return { occupants: Number(row?.occupants ?? 0), tenants: Number(row?.tenants ?? 0) }
}

/** Current and upcoming assignments, so a booked move-in still counts against the flat. */
function countResidents(tx: DbExecutor, flatId: string) {
  return tx.$count(
    flatResidents,
    and(eq(flatResidents.flatId, flatId), or(isNull(flatResidents.endDate), gte(flatResidents.endDate, sql`current_date`))),
  )
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

export async function loadFlat(executor: DbExecutor, ctx: AuthContext, id: string, lock?: Lock) {
  let query = executor
    .select({ flat: flats, societyId: blocks.societyId })
    .from(flats)
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .where(eq(flats.id, id))
    .$dynamic()
  if (lock) query = query.for(lock, { of: flats })
  const [row] = UUID.test(id) ? await query : []
  return requireRecord(ctx, row && { ...row.flat, societyId: row.societyId }, 'Flat')
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
// Gates
// ---------------------------------------------------------------------------

const duplicateGate = ['ALREADY_EXISTS', 'A gate with this name already exists in this society'] as const

async function loadGate(executor: DbExecutor, ctx: AuthContext, id: string, lock?: Lock) {
  let query = executor.select().from(gates).where(eq(gates.id, id)).$dynamic()
  if (lock) query = query.for(lock)
  const [row] = UUID.test(id) ? await query : []
  return requireRecord(ctx, row, 'Gate')
}

export async function listGates(ctx: AuthContext, societyId: string) {
  await loadSociety(db, ctx, societyId)
  return db.select().from(gates).where(eq(gates.societyId, societyId)).orderBy(sql`lower(${gates.name})`)
}

export function createGate(ctx: AuthContext, societyId: string, body: CreateGateBody) {
  return db.transaction(async (tx) => {
    await loadSociety(tx, ctx, societyId, 'share')
    const [gate] = await unique(tx.insert(gates).values({ societyId, ...body }).returning(), duplicateGate)
    await audit(tx, ctx, 'GATE_CREATED', { societyId, gateId: gate!.id, name: gate!.name })
    return gate!
  })
}

/** Renames, repurposes or (de)activates a gate. Guards posted to it keep their record. */
export function updateGate(ctx: AuthContext, gateId: string, body: UpdateGateBody) {
  const { reason, ...changes } = body
  return db.transaction(async (tx) => {
    const gate = await loadGate(tx, ctx, gateId, 'update')
    const [updated] = await unique(
      tx.update(gates).set({ ...changes, updatedAt: new Date() }).where(eq(gates.id, gateId)).returning(),
      duplicateGate,
    )
    await audit(tx, ctx, 'GATE_UPDATED', { societyId: gate.societyId, gateId, changes, reason })
    return updated!
  })
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const duplicateBlock = ['DUPLICATE_BLOCK', 'A block with this name already exists in this society'] as const

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
  const { reason, ...changes } = body
  return db.transaction(async (tx) => {
    const block = await loadBlock(tx, ctx, blockId, 'update')
    if (body.status === INACTIVE && block.status === ACTIVE) {
      // An active flat always sits on an active floor, so checking floors covers flats too
      const activeFloors = await tx.$count(floors, and(eq(floors.blockId, blockId), eq(floors.status, ACTIVE)))
      assertNoChildren(activeFloors === 0, 'Deactivate the floors in this block first')
    }
    const [updated] = await unique(
      tx.update(blocks).set({ ...changes, updatedAt: new Date() }).where(eq(blocks.id, blockId)).returning(),
      duplicateBlock,
    )
    await audit(tx, ctx, 'BLOCK_UPDATED', { societyId: block.societyId, blockId, changes, reason })
    return updated!
  })
}

// ---------------------------------------------------------------------------
// Floors
// ---------------------------------------------------------------------------

const duplicateFloor = ['DUPLICATE_FLOOR_LABEL', 'A floor with this label already exists in this block'] as const
const inactiveBlock = 'This block is inactive, so it cannot have active floors'

export async function listFloors(ctx: AuthContext, blockId: string) {
  await loadBlock(db, ctx, blockId)
  return db
    .select()
    .from(floors)
    .where(eq(floors.blockId, blockId))
    .orderBy(sql`${floors.sortOrder} asc nulls last`, sql`lower(${floors.floorLabel})`)
}

export function createFloor(ctx: AuthContext, blockId: string, body: CreateFloorBody) {
  return db.transaction(async (tx) => {
    const block = await loadBlock(tx, ctx, blockId, 'share')
    assertState(block.status === ACTIVE, inactiveBlock)
    const [floor] = await unique(
      tx.insert(floors).values({ blockId, floorLabel: body.floorLabel, sortOrder: body.sortOrder ?? null }).returning(),
      duplicateFloor,
    )
    await audit(tx, ctx, 'FLOOR_CREATED', { societyId: block.societyId, blockId, floorId: floor!.id, floorLabel: floor!.floorLabel })
    return floor!
  })
}

export function updateFloor(ctx: AuthContext, floorId: string, body: UpdateFloorBody) {
  const { reason, ...changes } = body
  return db.transaction(async (tx) => {
    const floor = await loadFloor(tx, ctx, floorId, 'update')
    if (body.status === INACTIVE && floor.status === ACTIVE) {
      const activeFlats = await tx.$count(flats, and(eq(flats.floorId, floorId), eq(flats.status, ACTIVE)))
      assertNoChildren(activeFlats === 0, 'Deactivate or move the flats on this floor first')
    }
    if (body.status === ACTIVE && floor.status === INACTIVE) {
      assertState((await loadBlock(tx, ctx, floor.blockId, 'share')).status === ACTIVE, inactiveBlock)
    }
    const [updated] = await unique(
      tx.update(floors).set({ ...changes, updatedAt: new Date() }).where(eq(floors.id, floorId)).returning(),
      duplicateFloor,
    )
    await audit(tx, ctx, 'FLOOR_UPDATED', { societyId: floor.societyId, blockId: floor.blockId, floorId, changes, reason })
    return updated!
  })
}

// ---------------------------------------------------------------------------
// Flats
// ---------------------------------------------------------------------------

const duplicateFlat = ['DUPLICATE_FLAT_NUMBER', 'A flat with this number already exists in this block'] as const
const inactiveFloor = 'This floor is inactive, so it cannot have active flats'

export async function listFlats(ctx: AuthContext, floorId: string) {
  await loadFloor(db, ctx, floorId)
  return db.select().from(flats).where(eq(flats.floorId, floorId)).orderBy(asc(flats.number))
}

/** The flat's block and society are taken from the floor, never from the request. */
export function createFlat(ctx: AuthContext, floorId: string, body: CreateFlatBody) {
  return db.transaction(async (tx) => {
    const floor = await loadFloor(tx, ctx, floorId, 'share')
    assertState(floor.status === ACTIVE, inactiveFloor)
    const [flat] = await unique(
      tx
        .insert(flats)
        .values({
          blockId: floor.blockId,
          floorId,
          number: body.number,
          sharingAllowed: body.sharingAllowed ?? false,
          maxOccupants: body.maxOccupants ?? null,
          flatType: body.flatType ?? null,
          carpetAreaSqft: body.carpetAreaSqft ?? null,
          parkingSlots: body.parkingSlots ?? null,
          intercom: body.intercom ?? null,
        })
        .returning(),
      duplicateFlat,
    )
    await audit(tx, ctx, 'FLAT_CREATED', { societyId: floor.societyId, flatId: flat!.id, floorId, number: flat!.number })
    return { ...flat!, societyId: floor.societyId }
  })
}

export async function getFlat(ctx: AuthContext, flatId: string) {
  const query = db
    .select({
      flat: flats,
      societyId: blocks.societyId,
      block: { id: blocks.id, name: blocks.name, status: blocks.status },
      floor: { id: floors.id, floorLabel: floors.floorLabel, status: floors.status },
    })
    .from(flats)
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(floors, eq(floors.id, flats.floorId))
    .where(eq(flats.id, flatId))
  const [row] = UUID.test(flatId) ? await query : []
  const flat = await requireRecord(ctx, row && { ...row.flat, societyId: row.societyId }, 'Flat')
  return { ...flat, block: row!.block, floor: row!.floor }
}

export function updateFlat(ctx: AuthContext, flatId: string, body: UpdateFlatBody) {
  const { reason, ...changes } = body
  return db.transaction(async (tx) => {
    const flat = await loadFlat(tx, ctx, flatId, 'update')
    const moving = body.floorId !== undefined && body.floorId !== flat.floorId
    const target = moving ? await loadFloor(tx, ctx, body.floorId!, 'share') : undefined
    if (target) assertState(target.status === ACTIVE, inactiveFloor)

    const sharingAllowed = body.sharingAllowed ?? flat.sharingAllowed
    // Turning sharing off clears the cap; the column is only meaningful while sharing is allowed
    const maxOccupants =
      body.sharingAllowed === false ? null : body.maxOccupants !== undefined ? body.maxOccupants : flat.maxOccupants
    assertState(sharingAllowed || maxOccupants === null, 'Allow sharing before setting a maximum number of occupants')
    if (body.sharingAllowed !== undefined || body.maxOccupants !== undefined) {
      const capacity = sharingAllowed ? maxOccupants : 1
      if (capacity !== null) {
        const { tenants } = await countOccupants(tx, flatId)
        assertState(tenants <= capacity, `This flat already has ${tenants} tenants, more than a limit of ${capacity}`)
      }
    }

    if (body.status === INACTIVE && flat.status === ACTIVE) {
      assertNoChildren((await countResidents(tx, flatId)) === 0, 'End the current and upcoming resident links for this flat first')
    }
    if (body.status === ACTIVE && flat.status === INACTIVE && !target) {
      assertState((await loadFloor(tx, ctx, flat.floorId, 'share')).status === ACTIVE, inactiveFloor)
    }

    const [updated] = await unique(
      tx
        .update(flats)
        .set({
          number: body.number,
          status: body.status,
          floorId: target?.id,
          blockId: target?.blockId,
          sharingAllowed,
          maxOccupants,
          flatType: body.flatType,
          carpetAreaSqft: body.carpetAreaSqft,
          parkingSlots: body.parkingSlots,
          intercom: body.intercom,
          updatedAt: new Date(),
        })
        .where(eq(flats.id, flatId))
        .returning(),
      duplicateFlat,
    )
    await audit(tx, ctx, 'FLAT_UPDATED', { societyId: flat.societyId, flatId, changes, reason })
    return { ...updated!, societyId: flat.societyId }
  })
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

type Status = 'ACTIVE' | 'INACTIVE'
type FlatType = (typeof flats.$inferSelect)['flatType']
type ResidentTypeValue = (typeof flatResidents.$inferSelect)['residentType']

interface FlatOccupancy {
  id: string
  number: string
  status: Status
  sharingAllowed: boolean
  maxOccupants: number | null
  flatType: FlatType | null
  carpetAreaSqft: number | null
  parkingSlots: string | null
  parkingSlotCount: number
  intercom: string | null
  /** Who holds the flat today, for the flats table: owners first, then tenants */
  residents: { name: string; residentType: ResidentTypeValue }[]
  owners: number
  tenants: number
  occupants: number
  /** null while sharing has no cap */
  slotsLeft: number | null
  ownership: 'UNSOLD' | 'OWNED'
  occupancy: 'VACANT' | 'SHARING' | 'FULL'
}

interface FloorOccupancy {
  id: string
  floorLabel: string
  sortOrder: number | null
  status: Status
  flats: FlatOccupancy[]
}

interface BlockOccupancy {
  id: string
  name: string
  status: Status
  floors: FloorOccupancy[]
}

/**
 * Ownership and occupancy are counted separately: owners come from OWNER assignments, occupants
 * from all of them, and the sharing cap applies to tenants alone.
 */
function flatOccupancy(row: {
  flatId: string
  number: string
  flatStatus: Status
  sharingAllowed: boolean
  maxOccupants: number | null
  flatType: FlatType | null
  carpetAreaSqft: number | null
  parkingSlots: string | null
  parkingSlotCount: number | null
  intercom: string | null
  residents: { name: string; residentType: ResidentTypeValue }[] | null
  owners: number | string | null
  occupants: number | string | null
}): FlatOccupancy {
  const owners = Number(row.owners ?? 0)
  const occupants = Number(row.occupants ?? 0)
  const tenants = occupants - owners
  // Sharing caps the tenants; without sharing the flat holds one occupant in all
  const slotsLeft = row.sharingAllowed
    ? row.maxOccupants === null
      ? null
      : Math.max(0, row.maxOccupants - tenants)
    : occupants === 0
      ? 1
      : 0
  return {
    id: row.flatId,
    number: row.number,
    status: row.flatStatus,
    sharingAllowed: row.sharingAllowed,
    maxOccupants: row.maxOccupants,
    flatType: row.flatType,
    carpetAreaSqft: row.carpetAreaSqft,
    parkingSlots: row.parkingSlots,
    parkingSlotCount: row.parkingSlotCount ?? 0,
    intercom: row.intercom,
    residents: row.residents ?? [],
    owners,
    tenants,
    occupants,
    slotsLeft,
    ownership: owners > 0 ? 'OWNED' : 'UNSOLD',
    occupancy: occupants === 0 ? 'VACANT' : slotsLeft === 0 ? 'FULL' : 'SHARING',
  }
}

/** Inactive flats are listed but never counted as sellable. */
function summarize(all: FlatOccupancy[]) {
  const active = all.filter((flat) => flat.status === ACTIVE)
  return {
    flats: active.length,
    inactive: all.length - active.length,
    unsold: active.filter((flat) => flat.ownership === 'UNSOLD').length,
    owned: active.filter((flat) => flat.ownership === 'OWNED').length,
    vacant: active.filter((flat) => flat.occupancy === 'VACANT').length,
    occupied: active.filter((flat) => flat.occupants > 0).length,
    sharingAvailable: active.filter((flat) => flat.sharingAllowed && flat.slotsLeft !== 0).length,
  }
}

/** The whole society as blocks → floors → flats, with what is sold, occupied and open to sharing. */
export async function getOccupancy(ctx: AuthContext, societyId: string) {
  const society = await loadSociety(db, ctx, societyId)

  // One row per flat holding verified assignments; a PENDING or future-dated one is not an occupant
  const links = db
    .select({
      flatId: flatResidents.flatId,
      owners: count(sql`case when ${flatResidents.residentType} = 'OWNER' then 1 end`).as('owners'),
      occupants: count().as('occupants'),
      // Owners first, so the flats table can show the owner and the tenant in their own columns
      residents: sql<{ name: string; residentType: ResidentTypeValue }[]>`json_agg(
        json_build_object('name', ${users.name}, 'residentType', ${flatResidents.residentType})
        order by ${flatResidents.residentType}, ${users.name}
      )`.as('residents'),
    })
    .from(flatResidents)
    .innerJoin(users, eq(users.id, flatResidents.userId))
    .where(
      and(
        eq(flatResidents.verificationStatus, 'VERIFIED'),
        lte(flatResidents.startDate, sql`current_date`),
        or(isNull(flatResidents.endDate), gte(flatResidents.endDate, sql`current_date`)),
      ),
    )
    .groupBy(flatResidents.flatId)
    .as('links')

  // Left joins so an empty block or floor still shows up for the Admin
  const rows = await db
    .select({
      blockId: blocks.id,
      blockName: blocks.name,
      blockStatus: blocks.status,
      floorId: floors.id,
      floorLabel: floors.floorLabel,
      sortOrder: floors.sortOrder,
      floorStatus: floors.status,
      flatId: flats.id,
      number: flats.number,
      flatStatus: flats.status,
      sharingAllowed: flats.sharingAllowed,
      maxOccupants: flats.maxOccupants,
      flatType: flats.flatType,
      carpetAreaSqft: flats.carpetAreaSqft,
      parkingSlots: flats.parkingSlots,
      parkingSlotCount: flats.parkingSlotCount,
      intercom: flats.intercom,
      residents: links.residents,
      owners: links.owners,
      occupants: links.occupants,
    })
    .from(blocks)
    .leftJoin(floors, eq(floors.blockId, blocks.id))
    .leftJoin(flats, eq(flats.floorId, floors.id))
    .leftJoin(links, eq(links.flatId, flats.id))
    .where(eq(blocks.societyId, societyId))
    .orderBy(
      sql`lower(${blocks.name})`,
      sql`${floors.sortOrder} asc nulls last`,
      sql`lower(${floors.floorLabel})`,
      asc(flats.number),
    )

  const tree: BlockOccupancy[] = []
  const blockById = new Map<string, BlockOccupancy>()
  const floorById = new Map<string, FloorOccupancy>()
  const everyFlat: FlatOccupancy[] = []

  for (const row of rows) {
    let block = blockById.get(row.blockId)
    if (!block) {
      block = { id: row.blockId, name: row.blockName, status: row.blockStatus, floors: [] }
      blockById.set(row.blockId, block)
      tree.push(block)
    }
    if (!row.floorId) continue
    let floor = floorById.get(row.floorId)
    if (!floor) {
      floor = {
        id: row.floorId,
        floorLabel: row.floorLabel!,
        sortOrder: row.sortOrder,
        status: row.floorStatus!,
        flats: [],
      }
      floorById.set(row.floorId, floor)
      block.floors.push(floor)
    }
    if (!row.flatId) continue
    const flat = flatOccupancy({
      ...row,
      flatId: row.flatId,
      number: row.number!,
      flatStatus: row.flatStatus!,
      sharingAllowed: row.sharingAllowed!,
      maxOccupants: row.maxOccupants,
    })
    floor.flats.push(flat)
    everyFlat.push(flat)
  }

  return { society: { id: society.id, name: society.name }, summary: summarize(everyFlat), blocks: tree }
}
