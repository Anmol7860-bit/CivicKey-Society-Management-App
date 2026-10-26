import { randomBytes } from 'node:crypto'
import { and, asc, eq, ilike, inArray, or } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { blocks, flats, gates, societies, staff, staffFlats } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { identityOf, withoutHash } from '../access/identity.js'
import { assertState, deny, permissionDenied, requireRecord, UUID } from '../access/scope.js'
import { recordAuditEvent, type AuditEventType, type DbExecutor } from '../audit/audit.service.js'
import { requireFile } from '../file/file.service.js'
import type { CreateStaffBody, ListStaffQuery, UpdateStaffBody } from './staff.schemas.js'

type Kind = (typeof staff.$inferSelect)['kind']

/** Guards are managed under Manage guards; everyone else under Register staff. */
const permissionFor = (kind: Kind) => (kind === 'GUARD' ? 'GUARD_MANAGE' : 'STAFF_MANAGE')

async function assertMayManage(ctx: AuthContext, kind: Kind) {
  const permission = permissionFor(kind)
  if (!ctx.permissions?.includes(permission)) throw await deny(ctx.userId, permissionDenied(), { permission, kind })
}

function audit(tx: DbExecutor, ctx: AuthContext, eventType: AuditEventType, metadata: Record<string, unknown>) {
  return recordAuditEvent(tx, { eventType, actorUserId: ctx.userId, metadata })
}

/** Maps a unique violation, including one lost to a concurrent insert, to 409. */
async function unique<T>(write: PromiseLike<T>, message: string) {
  try {
    return await write
  } catch (error) {
    const pgError = error as { code?: string; cause?: { code?: string } }
    if ((pgError.code ?? pgError.cause?.code) === '23505') throw new AppError(409, 'ALREADY_EXISTS', message)
    throw error
  }
}

const duplicatePhone = 'Someone with this mobile number is already on the society’s staff'

/** What the guard reads at the gate. Crockford-style characters only, so O/0 and I/1 cannot be confused. */
function issuePassCode() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const bytes = randomBytes(8)
  return `CK-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}`
}

async function loadSociety(executor: DbExecutor, ctx: AuthContext, id: string) {
  const [row] = UUID.test(id) ? await executor.select().from(societies).where(eq(societies.id, id)) : []
  await requireRecord(ctx, row && { societyId: row.id }, 'Society')
  return row!
}

/** 404 when missing, 403 CROSS_SOCIETY_ACCESS outside the Admin's society. */
async function loadStaff(executor: DbExecutor, ctx: AuthContext, id: string, lock?: 'update') {
  let query = executor.select().from(staff).where(eq(staff.id, id)).$dynamic()
  if (lock) query = query.for(lock)
  const [row] = UUID.test(id) ? await query : []
  return requireRecord(ctx, row, 'Staff member')
}

/** Every flat must belong to this society: a flat id from the request is never trusted. */
async function assertFlatsInSociety(tx: DbExecutor, societyId: string, flatIds: string[]) {
  if (flatIds.length === 0) return
  const rows = await tx
    .select({ id: flats.id })
    .from(flats)
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .where(and(inArray(flats.id, flatIds), eq(blocks.societyId, societyId), eq(flats.status, 'ACTIVE')))
  assertState(rows.length === flatIds.length, 'One of those flats is not an active flat in this society')
}

/** The gate must belong to this society and still be in use. */
async function assertGateInSociety(tx: DbExecutor, societyId: string, gateId: string) {
  const [gate] = await tx.select().from(gates).where(eq(gates.id, gateId))
  if (!gate || gate.societyId !== societyId) throw new AppError(404, 'NOT_FOUND', 'Gate not found')
  assertState(gate.status === 'ACTIVE', 'This gate is inactive, so nobody can be posted to it')
}

async function replaceFlats(tx: DbExecutor, staffId: string, served: CreateStaffBody['flatsServed']) {
  await tx.delete(staffFlats).where(eq(staffFlats.staffId, staffId))
  if (!served?.length) return
  await tx.insert(staffFlats).values(
    served.map((entry) => ({
      staffId,
      flatId: entry.flatId,
      timeWindow: entry.timeWindow ?? null,
    })),
  )
}

/** The flats each of these staff members works for, as the list and the edit form show them. */
async function flatsFor(staffIds: string[]) {
  if (staffIds.length === 0)
    return new Map<
      string,
      {
        flatId: string
        number: string
        blockName: string
        timeWindow: string | null
      }[]
    >()
  const rows = await db
    .select({
      staffId: staffFlats.staffId,
      flatId: staffFlats.flatId,
      timeWindow: staffFlats.timeWindow,
      number: flats.number,
      blockName: blocks.name,
    })
    .from(staffFlats)
    .innerJoin(flats, eq(flats.id, staffFlats.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .where(inArray(staffFlats.staffId, staffIds))
    .orderBy(asc(blocks.name), asc(flats.number))

  const byStaff = new Map<
    string,
    {
      flatId: string
      number: string
      blockName: string
      timeWindow: string | null
    }[]
  >()
  for (const row of rows) {
    const list = byStaff.get(row.staffId) ?? []
    list.push({
      flatId: row.flatId,
      number: row.number,
      blockName: row.blockName,
      timeWindow: row.timeWindow,
    })
    byStaff.set(row.staffId, list)
  }
  return byStaff
}

const present = <T>(value: T | undefined): value is T => value !== undefined

/**
 * The staff list for one tab of Staff management. A caller sees only the kinds they may manage,
 * so an Admin holding Manage guards alone never reads the society's daily help.
 */
export async function listStaff(ctx: AuthContext, societyId: string, query: ListStaffQuery) {
  await loadSociety(db, ctx, societyId)
  const kinds = (['GUARD', 'DAILY_HELP', 'VENDOR'] as const).filter(
    (kind) => (!query.kind || query.kind === kind) && ctx.permissions?.includes(permissionFor(kind)),
  )
  if (kinds.length === 0)
    throw await deny(ctx.userId, permissionDenied(), {
      societyId,
      kind: query.kind,
    })

  const search = query.search?.trim()
  const rows = await db
    .select({ staff, gateName: gates.name })
    .from(staff)
    .leftJoin(gates, eq(gates.id, staff.gateId))
    .where(
      and(
        eq(staff.societyId, societyId),
        inArray(staff.kind, kinds),
        ...[
          query.shift ? eq(staff.shift, query.shift) : undefined,
          query.status ? eq(staff.status, query.status) : undefined,
          search ? or(ilike(staff.name, `%${search}%`), ilike(staff.phone, `%${search}%`)) : undefined,
        ].filter(present),
      ),
    )
    .orderBy(asc(staff.name))

  const byStaff = await flatsFor(rows.map((row) => row.staff.id))
  return rows.map((row) => ({
    ...withoutHash(row.staff),
    gateName: row.gateName,
    flatsServed: byStaff.get(row.staff.id) ?? [],
  }))
}

/** Registers a staff member and issues the pass the guard checks at the gate. */
export function createStaff(ctx: AuthContext, societyId: string, body: CreateStaffBody) {
  return db.transaction(async (tx) => {
    await loadSociety(tx, ctx, societyId)
    await assertMayManage(ctx, body.kind)
    // idNumber never becomes a column: identityOf() turns it into the hash and the last 4
    const { flatsServed, idNumber: _idNumber, ...fields } = body
    if (fields.gateId) await assertGateInSociety(tx, societyId, fields.gateId)
    // A staff profile is never created pointing at a photo that was not stored
    await requireFile(societyId, fields.photoReference)
    await assertFlatsInSociety(tx, societyId, flatsServed?.map((entry) => entry.flatId) ?? [])

    const [created] = await unique(
      tx
        .insert(staff)
        .values({
          ...fields,
          societyId,
          passCode: issuePassCode(),
          ...identityOf(body),
        })
        .returning(),
      duplicatePhone,
    )
    await replaceFlats(tx, created!.id, flatsServed)
    await audit(tx, ctx, 'STAFF_REGISTERED', {
      societyId,
      staffId: created!.id,
      kind: created!.kind,
      flats: flatsServed?.length ?? 0,
    })
    return { ...withoutHash(created!), flatsServed: flatsServed ?? [] }
  })
}

/** Edits a staff member, replaces the flats they serve, or ends their engagement with a reason. */
export function updateStaff(ctx: AuthContext, id: string, body: UpdateStaffBody) {
  return db.transaction(async (tx) => {
    const current = await loadStaff(tx, ctx, id, 'update')
    await assertMayManage(ctx, current.kind)
    const { reason, flatsServed, idNumber, ...changes } = body
    void idNumber
    if (changes.gateId) await assertGateInSociety(tx, current.societyId, changes.gateId)
    if (changes.photoReference) await requireFile(current.societyId, changes.photoReference)
    if (flatsServed)
      await assertFlatsInSociety(
        tx,
        current.societyId,
        flatsServed.map((entry) => entry.flatId),
      )
    // Daily help exists to serve flats; emptying the list would leave a pass nobody expects
    assertState(
      current.kind !== 'DAILY_HELP' || flatsServed === undefined || flatsServed.length > 0,
      'Daily help must serve at least one flat',
    )

    const identity = body.idDocumentType !== undefined || idNumber !== undefined || body.idDocumentLast4 !== undefined
    const [updated] = await unique(
      tx
        .update(staff)
        .set({
          ...changes,
          ...(identity ? identityOf(body) : {}),
          updatedAt: new Date(),
        })
        .where(eq(staff.id, id))
        .returning(),
      duplicatePhone,
    )
    if (flatsServed) await replaceFlats(tx, id, flatsServed)
    await audit(tx, ctx, 'STAFF_UPDATED', {
      societyId: current.societyId,
      staffId: id,
      changes,
      reason,
    })
    return { ...withoutHash(updated!), flatsServed: flatsServed ?? [] }
  })
}

/** Issues a fresh pass code, e.g. when a pass is lost. The old code stops working at once. */
export function reissuePass(ctx: AuthContext, id: string) {
  return db.transaction(async (tx) => {
    const current = await loadStaff(tx, ctx, id, 'update')
    await assertMayManage(ctx, current.kind)
    assertState(current.status === 'ACTIVE', 'This staff member is inactive, so no pass can be issued')
    const [updated] = await tx
      .update(staff)
      .set({ passCode: issuePassCode(), updatedAt: new Date() })
      .where(eq(staff.id, id))
      .returning()
    await audit(tx, ctx, 'STAFF_PASS_REISSUED', {
      societyId: current.societyId,
      staffId: id,
    })
    return withoutHash(updated!)
  })
}
