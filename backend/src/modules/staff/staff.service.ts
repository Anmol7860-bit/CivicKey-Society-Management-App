import { randomBytes } from 'node:crypto'
import { and, asc, count, desc, eq, ilike, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { blocks, flats, gates, guardGateAssignments, societies, staff, staffFlats, users } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { decryptIdNumber, identityOf, withoutHash } from '../access/identity.js'
import { assignRole, loadRole } from '../access/permissions.js'
import { assertState, deny, permissionDenied, requireRecord, UUID } from '../access/scope.js'
import { revokeAllSessions } from '../auth/auth.service.js'
import { hashPassword } from '../auth/password.js'
import { issueSetupCode } from '../auth/passwordSetup.js'
import { recordAuditEvent, type AuditEventType, type DbExecutor } from '../audit/audit.service.js'
import { requireFile } from '../file/file.service.js'
import { idRequired } from '../society/society.service.js'
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

type StaffRow = typeof staff.$inferSelect

/**
 * Puts a guard's account on the gate their profile names and closes the posting they were on.
 *
 * The posting in guard_gate_assignments is what a gate operation is checked against, so it is
 * written wherever the gate on the profile changes rather than left for someone to insert by
 * hand. A guard with no account yet gets their posting when the account is linked.
 */
async function postToGate(tx: DbExecutor, ctx: AuthContext, member: StaffRow, gateId: string | null) {
  if (!member.userId) return
  const open = await tx
    .select({ id: guardGateAssignments.id, gateId: guardGateAssignments.gateId })
    .from(guardGateAssignments)
    .where(and(eq(guardGateAssignments.guardUserId, member.userId), isNull(guardGateAssignments.endAt)))
  if (open.length === 1 && open[0]!.gateId === gateId) return

  const now = new Date()
  if (open.length > 0) {
    await tx
      .update(guardGateAssignments)
      .set({ endAt: now })
      .where(and(eq(guardGateAssignments.guardUserId, member.userId), isNull(guardGateAssignments.endAt)))
  }
  if (gateId) {
    await tx
      .insert(guardGateAssignments)
      .values({ guardUserId: member.userId, gateId, assignedBy: ctx.userId, startAt: now })
  }
  await audit(tx, ctx, 'STAFF_POSTED_TO_GATE', { societyId: member.societyId, staffId: member.id, gateId })
}

/** Every gate this guard has been posted to, newest first: the assignment history of the profile. */
async function postingsFor(userId: string | null) {
  if (!userId) return []
  return db
    .select({
      id: guardGateAssignments.id,
      gateId: guardGateAssignments.gateId,
      gateName: gates.name,
      startAt: guardGateAssignments.startAt,
      endAt: guardGateAssignments.endAt,
    })
    .from(guardGateAssignments)
    .innerJoin(gates, eq(gates.id, guardGateAssignments.gateId))
    .where(eq(guardGateAssignments.guardUserId, userId))
    .orderBy(desc(guardGateAssignments.startAt))
}

/** The accounts behind a page of staff, so the list can show who cannot sign in yet. */
async function accountsFor(userIds: string[]) {
  if (userIds.length === 0) return new Map<string, { id: string; name: string; isActive: boolean }>()
  const rows = await db
    .select({ id: users.id, name: users.name, isActive: users.isActive })
    .from(users)
    .where(inArray(users.id, userIds))
  return new Map(rows.map((row) => [row.id, row]))
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
  const where = and(
    eq(staff.societyId, societyId),
    inArray(staff.kind, kinds),
    ...[
      query.shift ? eq(staff.shift, query.shift) : undefined,
      query.status ? eq(staff.status, query.status) : undefined,
      search ? or(ilike(staff.name, `%${search}%`), ilike(staff.phone, `%${search}%`)) : undefined,
    ].filter(present),
  )
  // The page is small by default: a society's staff list is read on a phone over a slow line
  const limit = query.limit ?? 25
  const offset = query.offset ?? 0
  const [counted] = await db.select({ total: count() }).from(staff).where(where)
  const rows = await db
    .select({ staff, gateName: gates.name })
    .from(staff)
    .leftJoin(gates, eq(gates.id, staff.gateId))
    .where(where)
    .orderBy(asc(staff.name), asc(staff.id))
    .limit(limit)
    .offset(offset)

  const byStaff = await flatsFor(rows.map((row) => row.staff.id))
  const accounts = await accountsFor(rows.map((row) => row.staff.userId).filter((id) => id !== null))
  return {
    total: counted?.total ?? 0,
    staff: rows.map((row) => ({
      ...withoutHash(row.staff),
      gateName: row.gateName,
      account: row.staff.userId ? (accounts.get(row.staff.userId) ?? null) : null,
      flatsServed: byStaff.get(row.staff.id) ?? [],
    })),
  }
}

/** One staff profile in full, with the account behind it and every gate it has been posted to. */
export async function getStaff(ctx: AuthContext, id: string) {
  const member = await loadStaff(db, ctx, id)
  await assertMayManage(ctx, member.kind)
  const [gate] = member.gateId ? await db.select({ name: gates.name }).from(gates).where(eq(gates.id, member.gateId)) : []
  const accounts = await accountsFor(member.userId ? [member.userId] : [])
  return {
    ...withoutHash(member),
    gateName: gate?.name ?? null,
    account: member.userId ? (accounts.get(member.userId) ?? null) : null,
    flatsServed: (await flatsFor([member.id])).get(member.id) ?? [],
    postings: await postingsFor(member.userId),
  }
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
    // Some societies insist on a government ID; the setting is theirs to make, not this code's
    if (await idRequired(societyId)) {
      assertState(
        Boolean(fields.idDocumentType && (body.idNumber || fields.idDocumentLast4)),
        'This society requires a government ID for every staff member',
      )
    }
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
    await applyStatus(tx, ctx, current, updated!, reason)
    return { ...withoutHash(updated!), flatsServed: flatsServed ?? [] }
  })
}

/**
 * What a change of status does beyond the column.
 *
 * Deactivating has to reach the account as well: the profile going inactive is worth nothing
 * while the guard's access token is still accepted, so the posting is closed, the account is
 * switched off and every live session and refresh token of it is revoked. Reactivating restores
 * the account and puts the guard back on the gate the profile names, if that gate is still open.
 */
async function applyStatus(tx: DbExecutor, ctx: AuthContext, before: StaffRow, after: StaffRow, reason?: string) {
  if (after.status === 'INACTIVE' && before.status === 'ACTIVE') {
    await postToGate(tx, ctx, after, null)
    const sessionsRevoked = after.userId ? await revokeAllSessions(tx, after.userId, 'STAFF_DEACTIVATED') : 0
    if (after.userId) {
      await tx.update(users).set({ isActive: false, updatedAt: new Date() }).where(eq(users.id, after.userId))
    }
    await audit(tx, ctx, 'STAFF_DEACTIVATED', {
      societyId: after.societyId,
      staffId: after.id,
      userId: after.userId,
      sessionsRevoked,
      reason,
    })
    return
  }
  if (after.status === 'ACTIVE' && before.status === 'INACTIVE') {
    if (after.gateId) await assertGateInSociety(tx, after.societyId, after.gateId)
    if (after.userId) {
      await tx.update(users).set({ isActive: true, updatedAt: new Date() }).where(eq(users.id, after.userId))
    }
    await postToGate(tx, ctx, after, after.gateId)
    await audit(tx, ctx, 'STAFF_REACTIVATED', { societyId: after.societyId, staffId: after.id, userId: after.userId })
    return
  }
  // An ordinary edit that moved the guard to another gate: the posting follows the profile
  if (after.status === 'ACTIVE' && after.gateId !== before.gateId) await postToGate(tx, ctx, after, after.gateId)
}

/**
 * Gives a guard the account they sign in with, or links the one they already have.
 *
 * The profile on its own authorizes nothing: the account is what carries the GUARD role and this
 * society, and a guard cannot use a guard function until it exists. A new account leaves with a
 * one-time code for the office to hand over; an account that already exists keeps its password.
 */
export function linkAccount(ctx: AuthContext, id: string) {
  return db.transaction(async (tx) => {
    const member = await loadStaff(tx, ctx, id, 'update')
    await assertMayManage(ctx, member.kind)
    assertState(member.kind === 'GUARD', 'Only a guard signs in to the app, so only a guard is given an account')
    assertState(member.status === 'ACTIVE', 'This staff member is inactive, so no account can be linked')
    if (member.userId) throw new AppError(409, 'ALREADY_EXISTS', 'This guard already has an account')

    const [existing] = await tx
      .select({ id: users.id, name: users.name, societyId: users.societyId, isActive: users.isActive })
      .from(users)
      .where(eq(users.phone, member.phone))
    if (existing) {
      assertState(existing.societyId === member.societyId, 'This mobile number is registered in another society')
      assertState(existing.isActive, 'That account is deactivated')
      // An account that is already a resident's or an Admin's is not quietly turned into a guard
      const role = await loadRole(tx, existing.id)
      assertState(role === undefined || role === 'GUARD', 'That account is already in use by someone else')
    }
    let account: { id: string; name: string } | undefined = existing
    if (!account) {
      const created = await unique(
        tx
          .insert(users)
          .values({
            name: member.name,
            phone: member.phone,
            societyId: member.societyId,
            // Unusable by design: the guard gets in through the one-time code issued below
            passwordHash: await hashPassword(randomBytes(32).toString('hex')),
          })
          .returning({ id: users.id, name: users.name }),
        'Someone with this mobile number already has an account',
      )
      account = created[0]!
    }

    await assignRole(tx, account.id, 'GUARD')
    const [updated] = await unique(
      tx.update(staff).set({ userId: account.id, updatedAt: new Date() }).where(eq(staff.id, id)).returning(),
      'That account is already linked to another staff member',
    )
    const loginCode = existing ? null : await issueSetupCode(ctx, account.id, tx)
    await postToGate(tx, ctx, updated!, updated!.gateId)
    await audit(tx, ctx, 'STAFF_ACCOUNT_LINKED', {
      societyId: member.societyId,
      staffId: id,
      userId: account.id,
      created: !existing,
    })
    return {
      ...withoutHash(updated!),
      account: { id: account.id, name: account.name, isActive: true },
      loginCode,
    }
  })
}

/**
 * The captured ID number itself, for the one read that is allowed to see it.
 *
 * A society has to be able to show an authority the document it recorded, so the number is
 * recoverable - but every reading of it is a line in the audit log naming who looked and why,
 * and the number is in no other response and no log.
 */
export function revealIdNumber(ctx: AuthContext, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const member = await loadStaff(tx, ctx, id)
    await assertMayManage(ctx, member.kind)
    assertState(member.idDocumentEncrypted !== null, 'No ID document is on file for this staff member')
    await audit(tx, ctx, 'STAFF_ID_REVEALED', {
      societyId: member.societyId,
      staffId: id,
      idDocumentType: member.idDocumentType,
      reason,
    })
    return {
      idDocumentType: member.idDocumentType,
      idNumber: decryptIdNumber(member.idDocumentEncrypted),
    }
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
