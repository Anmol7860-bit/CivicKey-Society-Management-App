import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, not, or, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { blocks, flatResidents, flats, floors, societies, users, visits } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { identityOf, withoutHash } from '../access/identity.js'
import { assignRole } from '../access/permissions.js'
import { assertSameSociety, assertState, requireRecord, UUID } from '../access/scope.js'
import { effectiveApprover } from '../gate/gate.service.js'
import { hashPassword } from '../auth/password.js'
import { issueSetupCode } from '../auth/passwordSetup.js'
import { recordAuditEvent, type AuditEventType, type DbExecutor } from '../audit/audit.service.js'
import { countOccupants, loadFlat } from '../society/society.service.js'
import type {
  ListResidentsQuery,
  RegisterResidentBody,
  RejectResidentBody,
  UpdateResidentBody,
  VerifyResidentBody,
} from './resident.schemas.js'

const PENDING = 'PENDING'
const VERIFIED = 'VERIFIED'
const REJECTED = 'REJECTED'

const userColumns = { id: users.id, name: users.name, phone: users.phone, email: users.email }

/** Maps a unique or overlapping-assignment violation to 409. */
async function conflict<T>(write: PromiseLike<T>, message: string) {
  try {
    return await write
  } catch (error) {
    const pgError = error as { code?: string; cause?: { code?: string } }
    const code = pgError.code ?? pgError.cause?.code
    if (code === '23505' || code === '23P01') throw new AppError(409, 'ALREADY_EXISTS', message)
    throw error
  }
}

function audit(tx: DbExecutor, ctx: AuthContext, eventType: AuditEventType, metadata: Record<string, unknown>) {
  return recordAuditEvent(tx, { eventType, actorUserId: ctx.userId, metadata })
}

/**
 * ponytail: retention is decided (2026-10-21) but not enforced - the identity columns are to be
 * cleared 7 years after end_date, matching how co-operative societies retain member records. Add
 * the scheduled purge when a job runner exists; the audit log keeps the fact of verification.
 */

/** 404 when missing, 403 CROSS_SOCIETY_ACCESS outside the Admin's society. */
async function loadAssignment(executor: DbExecutor, ctx: AuthContext, id: string, lock?: 'update') {
  let query = executor
    .select({ assignment: flatResidents, societyId: blocks.societyId, today: sql<string>`current_date` })
    .from(flatResidents)
    .innerJoin(flats, eq(flats.id, flatResidents.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .where(eq(flatResidents.id, id))
    .$dynamic()
  if (lock) query = query.for(lock, { of: flatResidents })
  const [row] = UUID.test(id) ? await query : []
  await requireRecord(ctx, row && { societyId: row.societyId }, 'Assignment')
  return row!
}

/** The profile columns the Add user form collects, as given; absent keys are left untouched. */
function profileOf(body: RegisterResidentBody) {
  const columns = {
    dateOfBirth: body.dateOfBirth,
    gender: body.gender,
    preferredLanguage: body.preferredLanguage,
    alternatePhone: body.alternatePhone,
    emergencyContactName: body.emergencyContactName,
    emergencyContactRelationship: body.emergencyContactRelationship,
    emergencyContactPhone: body.emergencyContactPhone,
  }
  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined))
}

/**
 * Links the registration to the account that already holds this mobile number, or creates one.
 * An existing account keeps its name, email and role: a committee member may own a flat. Profile
 * details given here are written either way, so an Admin filling them in for someone who already
 * has an account is not silently ignored.
 */
async function findOrCreateUser(tx: DbExecutor, societyId: string, body: RegisterResidentBody) {
  const [existing] = await tx
    .select({ ...userColumns, societyId: users.societyId, isActive: users.isActive })
    .from(users)
    .where(eq(users.phone, body.phone))
  if (existing) {
    assertState(existing.societyId === societyId, 'This mobile number is registered in another society')
    assertState(existing.isActive, 'This account is deactivated')
    const profile = profileOf(body)
    if (Object.keys(profile).length > 0) {
      await tx.update(users).set({ ...profile, updatedAt: new Date() }).where(eq(users.id, existing.id))
    }
    return { user: { id: existing.id, name: existing.name, phone: existing.phone, email: existing.email }, isNew: false }
  }
  const [created] = await conflict(
    tx
      .insert(users)
      .values({
        name: body.name,
        phone: body.phone,
        email: body.email ?? null,
        societyId,
        ...profileOf(body),
        // Unusable by design: the account gets in through the one-time code issued below, so
        // there is never a shared default password to guess
        passwordHash: await hashPassword(randomBytes(32).toString('hex')),
      })
      .returning(userColumns),
    'This email is already registered',
  )
  await assignRole(tx, created!.id, 'RESIDENT')
  return { user: created!, isNew: true }
}

/**
 * Registers an owner or tenant against a flat. The assignment starts PENDING and grants nothing
 * until an Admin verifies it, so completing OTP or holding an account is never enough.
 */
export function registerResident(ctx: AuthContext, flatId: string, body: RegisterResidentBody) {
  return db.transaction(async (tx) => {
    const flat = await loadFlat(tx, ctx, flatId, 'share')
    assertState(flat.status === 'ACTIVE', 'This flat is inactive, so it cannot take new residents')
    const { user, isNew } = await findOrCreateUser(tx, flat.societyId, body)
    const [assignment] = await conflict(
      tx
        .insert(flatResidents)
        .values({
          flatId,
          userId: user.id,
          residentType: body.residentType,
          relationship: body.relationship ?? null,
          accessLevel: body.accessLevel ?? 'FULL',
          startDate: body.startDate,
          endDate: body.endDate ?? null,
          ...identityOf(body),
          proofReference: body.proofReference ?? null,
        })
        .returning(),
      'This person already has an assignment on this flat for an overlapping period',
    )
    await audit(tx, ctx, 'RESIDENT_REGISTERED', {
      societyId: flat.societyId,
      flatId,
      assignmentId: assignment!.id,
      userId: user.id,
      residentType: body.residentType,
    })
    // A brand-new account has no usable password, so the Admin leaves with a code to hand over.
    // An existing account keeps its own password and gets a code from the directory if asked.
    const loginCode = isNew ? await issueSetupCode(ctx, user.id, tx) : null
    return { ...withoutHash(assignment!), user, loginCode }
  })
}

/**
 * Puts the owner's access where the tenancy says it should be, and tells the gate about it.
 *
 * While a verified tenant is in the flat, the tenant holds FULL access and the owner drops to
 * VIEW_ONLY: they can still see visits and bills, but they cannot approve a visitor or pay. When
 * the tenancy closes, the owner's FULL access comes back. Nobody sets this by hand, because the
 * two halves have to agree and an admin who forgets the second half leaves a flat with two
 * approvers or none.
 *
 * Then any visit still waiting on an answer is re-checked: if the flat no longer has anyone who
 * can answer, it goes to the guard now rather than waiting out a three-minute timeout.
 */
async function syncOwnerAccess(tx: DbExecutor, ctx: AuthContext, flatId: string) {
  const [tenant] = await tx
    .select({ id: flatResidents.id })
    .from(flatResidents)
    .where(
      and(
        eq(flatResidents.flatId, flatId),
        eq(flatResidents.residentType, 'TENANT'),
        eq(flatResidents.verificationStatus, VERIFIED),
        isNull(flatResidents.endDate),
      ),
    )
  const activeOwner = and(eq(flatResidents.flatId, flatId), eq(flatResidents.residentType, 'OWNER'), isNull(flatResidents.endDate))
  const ownerAccess = tenant ? 'VIEW_ONLY' : 'FULL'

  const changed = await tx
    .update(flatResidents)
    .set({ accessLevel: ownerAccess, accessSuspendedByTenancy: Boolean(tenant), updatedAt: new Date() })
    .where(
      tenant
        ? // Only owners who hold full access are lowered; one an Admin already made view-only
          // stays as it is, and is not marked as suspended by this tenancy
          and(activeOwner, eq(flatResidents.accessLevel, 'FULL'))
        : // Only the owners this mechanism lowered are restored
          and(activeOwner, eq(flatResidents.accessSuspendedByTenancy, true)),
    )
    .returning({ id: flatResidents.id, userId: flatResidents.userId })

  for (const owner of changed) {
    await audit(tx, ctx, 'RESIDENT_UPDATED', {
      flatId,
      assignmentId: owner.id,
      userId: owner.userId,
      changes: { accessLevel: ownerAccess },
      reason: tenant ? 'A tenant now holds full access to this flat' : 'The tenancy closed, so full access returns to the owner',
    })
  }

  // A visit waiting on a resident who can no longer answer belongs to the guard
  if (!(await effectiveApprover(flatId))) {
    await tx
      .update(visits)
      .set({ status: 'AWAITING_MANUAL', updatedAt: new Date() })
      .where(and(eq(visits.flatId, flatId), eq(visits.status, 'AWAITING_APPROVAL')))
  }
}

/** Approves a registration. Only from here on does the person have access to the flat. */
export function verifyResident(ctx: AuthContext, id: string, body: VerifyResidentBody) {
  return db.transaction(async (tx) => {
    const { assignment, societyId, today } = await loadAssignment(tx, ctx, id, 'update')
    assertState(assignment.verificationStatus === PENDING, 'This registration has already been decided')
    assertState(assignment.endDate === null || assignment.endDate >= today, 'This assignment has already ended')

    // FOR UPDATE on the flat so two tenants cannot be verified into the last slot at once
    const flat = await loadFlat(tx, ctx, assignment.flatId, 'update')
    assertState(flat.status === 'ACTIVE', 'This flat is inactive, so its residents cannot be verified')
    if (assignment.residentType === 'TENANT') {
      const capacity = flat.sharingAllowed ? flat.maxOccupants : 1
      if (capacity !== null) {
        const { tenants } = await countOccupants(tx, flat.id)
        assertState(
          tenants < capacity,
          flat.sharingAllowed
            ? `This flat allows at most ${capacity} tenants`
            : 'This flat does not allow sharing and already has a tenant',
        )
      }
    }

    const [updated] = await tx
      .update(flatResidents)
      .set({
        verificationStatus: VERIFIED,
        verifiedBy: ctx.userId,
        verifiedAt: new Date(),
        accessLevel: body.accessLevel,
        rejectedReason: null,
        updatedAt: new Date(),
      })
      .where(eq(flatResidents.id, id))
      .returning()
    await audit(tx, ctx, 'RESIDENT_VERIFIED', {
      societyId,
      flatId: assignment.flatId,
      assignmentId: id,
      userId: assignment.userId,
      residentType: assignment.residentType,
    })
    // A verified tenant takes full access, which moves the owner to view-only
    await syncOwnerAccess(tx, ctx, assignment.flatId)
    return withoutHash(updated!)
  })
}

export function rejectResident(ctx: AuthContext, id: string, body: RejectResidentBody) {
  return db.transaction(async (tx) => {
    const { assignment, societyId } = await loadAssignment(tx, ctx, id, 'update')
    assertState(assignment.verificationStatus === PENDING, 'This registration has already been decided')
    const [updated] = await tx
      .update(flatResidents)
      .set({ verificationStatus: REJECTED, rejectedReason: body.reason, updatedAt: new Date() })
      .where(eq(flatResidents.id, id))
      .returning()
    await audit(tx, ctx, 'RESIDENT_REJECTED', { societyId, flatId: assignment.flatId, assignmentId: id, reason: body.reason })
    return withoutHash(updated!)
  })
}

/**
 * Extends or closes a tenancy and changes the access level. An assignment that has already ended
 * is never reopened: the person must be registered and verified again.
 */
export function updateResident(ctx: AuthContext, id: string, body: UpdateResidentBody) {
  return db.transaction(async (tx) => {
    const { assignment, societyId, today } = await loadAssignment(tx, ctx, id, 'update')
    assertState(assignment.verificationStatus !== REJECTED, 'A rejected registration cannot be changed')
    const endDate = body.endDate !== undefined ? body.endDate : assignment.endDate
    if (body.endDate !== undefined) {
      assertState(
        assignment.endDate === null || assignment.endDate >= today,
        'This assignment has already ended; register the resident again',
      )
    }
    assertState(endDate === null || endDate >= assignment.startDate, 'The end date cannot be before the start date')
    // Closing an assignment is recorded with its reason and actor, since billing and visitor
    // history will lean on these relationships long after the resident has gone
    const closing = body.endDate !== undefined && endDate !== null && endDate <= today
    assertState(!closing || body.reason !== undefined, 'Give a reason for closing this assignment')

    const [updated] = await conflict(
      tx
        .update(flatResidents)
        .set({ endDate, accessLevel: body.accessLevel, updatedAt: new Date() })
        .where(eq(flatResidents.id, id))
        .returning(),
      'This period overlaps another assignment of the same person on this flat',
    )
    const { reason, ...changes } = body
    await audit(tx, ctx, 'RESIDENT_UPDATED', { societyId, flatId: assignment.flatId, assignmentId: id, changes, reason })
    // Closing a tenancy hands full access back to the owner, in this same transaction
    await syncOwnerAccess(tx, ctx, assignment.flatId)
    return withoutHash(updated!)
  })
}

/** active: verified and inside its period. eligible: active with FULL access, so visitor approvals route here. */
function view(row: { assignment: typeof flatResidents.$inferSelect; user: { id: string }; today: string }) {
  const { assignment, today } = row
  const active =
    assignment.verificationStatus === VERIFIED &&
    assignment.startDate <= today &&
    (assignment.endDate === null || assignment.endDate >= today)
  return { ...withoutHash(assignment), user: row.user, active, eligible: active && assignment.accessLevel === 'FULL' }
}

/** Every assignment on the flat, current and historical, newest first. */
export async function listFlatResidents(ctx: AuthContext, flatId: string) {
  await loadFlat(db, ctx, flatId)
  const rows = await db
    .select({ assignment: flatResidents, user: userColumns, today: sql<string>`current_date` })
    .from(flatResidents)
    .innerJoin(users, eq(users.id, flatResidents.userId))
    .where(eq(flatResidents.flatId, flatId))
    .orderBy(desc(flatResidents.createdAt))
  return rows.map(view)
}

/**
 * The Admin's resident directory for a society: owners and tenants, current and historical.
 * `?status=PENDING` is the approval queue, `?active=true` who holds access right now, and
 * `?search=` is the one box that takes a name, a mobile, a flat number, A-101 or a flat id.
 */
export async function listResidents(ctx: AuthContext, societyId: string, query: ListResidentsQuery) {
  await assertSameSociety(ctx, societyId)
  const isActive = and(
    eq(flatResidents.verificationStatus, VERIFIED),
    lte(flatResidents.startDate, sql`current_date`),
    or(isNull(flatResidents.endDate), gte(flatResidents.endDate, sql`current_date`)),
  )!
  const filters = [eq(blocks.societyId, societyId)]
  if (query.status) filters.push(eq(flatResidents.verificationStatus, query.status))
  if (query.residentType) filters.push(eq(flatResidents.residentType, query.residentType))
  if (query.active) filters.push(query.active === 'true' ? isActive : not(isActive))
  if (query.search) {
    const term = `%${query.search}%`
    filters.push(
      or(
        ilike(users.name, term),
        ilike(users.phone, term),
        ilike(flats.number, term),
        ilike(sql`${blocks.name} || '-' || ${flats.number}`, term),
        ilike(sql`${flats.id}::text`, term),
      )!,
    )
  }

  const rows = await db
    .select({
      assignment: flatResidents,
      user: userColumns,
      today: sql<string>`current_date`,
      flat: { id: flats.id, number: flats.number, flatType: flats.flatType, carpetAreaSqft: flats.carpetAreaSqft },
      floor: { id: floors.id, floorLabel: floors.floorLabel },
      block: { id: blocks.id, name: blocks.name },
    })
    .from(flatResidents)
    .innerJoin(flats, eq(flats.id, flatResidents.flatId))
    .innerJoin(floors, eq(floors.id, flats.floorId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(users, eq(users.id, flatResidents.userId))
    .where(and(...filters))
    // A searched flat reads as a household: owners first, then tenants, newest assignment first
    .orderBy(asc(blocks.name), asc(flats.number), asc(flatResidents.residentType), desc(flatResidents.createdAt))
  return rows.map((row) => ({ ...view(row), flat: row.flat, floor: row.floor, block: row.block }))
}

/**
 * The signed-in person's own assignments, current and historical. Access is derived from the
 * stored dates, so a tenancy stops being `active` the day it expires with nothing to run.
 * Household members are returned only for an assignment that is active and has FULL access;
 * a VIEW_ONLY member or an expired tenancy sees their own row and nothing else.
 */
export async function listMyAssignments(ctx: AuthContext) {
  const rows = await db
    .select({
      assignment: flatResidents,
      user: userColumns,
      today: sql<string>`current_date`,
      flat: { id: flats.id, number: flats.number, sharingAllowed: flats.sharingAllowed, maxOccupants: flats.maxOccupants },
      floor: { id: floors.id, floorLabel: floors.floorLabel },
      block: { id: blocks.id, name: blocks.name },
      society: { id: societies.id, name: societies.name },
    })
    .from(flatResidents)
    .innerJoin(flats, eq(flats.id, flatResidents.flatId))
    .innerJoin(floors, eq(floors.id, flats.floorId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(societies, eq(societies.id, blocks.societyId))
    .innerJoin(users, eq(users.id, flatResidents.userId))
    .where(eq(flatResidents.userId, ctx.userId))
    .orderBy(desc(flatResidents.startDate))

  const mine = rows.map((row) => ({ ...view(row), flat: row.flat, floor: row.floor, block: row.block, society: row.society }))
  const shared = mine.filter((row) => row.eligible).map((row) => row.flatId)
  const household = shared.length
    ? await db
        .select({ flatId: flatResidents.flatId, name: users.name, residentType: flatResidents.residentType, accessLevel: flatResidents.accessLevel })
        .from(flatResidents)
        .innerJoin(users, eq(users.id, flatResidents.userId))
        .where(
          and(
            inArray(flatResidents.flatId, shared),
            eq(flatResidents.verificationStatus, VERIFIED),
            lte(flatResidents.startDate, sql`current_date`),
            or(isNull(flatResidents.endDate), gte(flatResidents.endDate, sql`current_date`)),
          ),
        )
        .orderBy(users.name)
    : []

  return mine.map((row) => ({
    ...row,
    household: row.eligible ? household.filter((member) => member.flatId === row.flatId).map(({ flatId, ...member }) => member) : [],
  }))
}
