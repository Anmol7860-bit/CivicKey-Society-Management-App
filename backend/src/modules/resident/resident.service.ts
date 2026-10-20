import { createHmac, randomBytes } from 'node:crypto'
import { and, desc, eq, gte, isNull, lte, not, or, sql } from 'drizzle-orm'
import { env } from '../../config/env.js'
import { db } from '../../db/client.js'
import { blocks, flatResidents, flats, users } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { assignRole } from '../access/permissions.js'
import { assertSameSociety, assertState, requireRecord, UUID } from '../access/scope.js'
import { hashPassword } from '../auth/password.js'
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
 * Identity is kept as the document type, a keyed hash and the last 4 digits; the number itself is
 * never stored, returned or logged. Without a configured pepper the server refuses the full number
 * rather than storing a hash a 12-digit value could be guessed against.
 */
function identityOf(body: RegisterResidentBody) {
  const columns = { idDocumentType: body.idDocumentType ?? null, idDocumentLast4: body.idDocumentLast4 ?? null }
  if (!body.idNumber) return { ...columns, idDocumentHash: null }
  assertState(
    env.ID_HASH_PEPPER !== undefined,
    'This server cannot accept a full ID number; send only its last 4 characters',
  )
  return {
    ...columns,
    idDocumentLast4: body.idNumber.slice(-4),
    idDocumentHash: createHmac('sha256', env.ID_HASH_PEPPER!).update(`${body.idDocumentType}:${body.idNumber}`).digest('hex'),
  }
}

/** The ID hash is stored for matching, never served: callers only learn whether one is on file. */
function withoutHash<T extends { idDocumentHash: string | null }>(row: T) {
  const { idDocumentHash, ...rest } = row
  return { ...rest, idDocumentOnFile: idDocumentHash !== null }
}

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

/**
 * Links the registration to the account that already holds this mobile number, or creates one.
 * An existing account keeps its name, email and role: a committee member may own a flat.
 */
async function findOrCreateUser(tx: DbExecutor, societyId: string, body: RegisterResidentBody) {
  const [existing] = await tx
    .select({ ...userColumns, societyId: users.societyId, isActive: users.isActive })
    .from(users)
    .where(eq(users.phone, body.phone))
  if (existing) {
    assertState(existing.societyId === societyId, 'This mobile number is registered in another society')
    assertState(existing.isActive, 'This account is deactivated')
    return { id: existing.id, name: existing.name, phone: existing.phone, email: existing.email }
  }
  const [created] = await conflict(
    tx
      .insert(users)
      .values({
        name: body.name,
        phone: body.phone,
        email: body.email ?? null,
        societyId,
        // ponytail: an unusable random password. Admin-registered residents cannot log in until
        // OTP or a set-password flow lands; give them one there rather than a shared default.
        passwordHash: await hashPassword(randomBytes(32).toString('hex')),
      })
      .returning(userColumns),
    'This email is already registered',
  )
  await assignRole(tx, created!.id, 'RESIDENT')
  return created!
}

/**
 * Registers an owner or tenant against a flat. The assignment starts PENDING and grants nothing
 * until an Admin verifies it, so completing OTP or holding an account is never enough.
 */
export function registerResident(ctx: AuthContext, flatId: string, body: RegisterResidentBody) {
  return db.transaction(async (tx) => {
    const flat = await loadFlat(tx, ctx, flatId, 'share')
    assertState(flat.status === 'ACTIVE', 'This flat is inactive, so it cannot take new residents')
    const user = await findOrCreateUser(tx, flat.societyId, body)
    const [assignment] = await conflict(
      tx
        .insert(flatResidents)
        .values({
          flatId,
          userId: user.id,
          residentType: body.residentType,
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
    return { ...withoutHash(assignment!), user }
  })
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
    assertState(assignment.residentType !== 'TENANT' || endDate !== null, 'A tenancy must have an end date')
    assertState(endDate === null || endDate >= assignment.startDate, 'The end date cannot be before the start date')

    const [updated] = await conflict(
      tx
        .update(flatResidents)
        .set({ endDate, accessLevel: body.accessLevel, updatedAt: new Date() })
        .where(eq(flatResidents.id, id))
        .returning(),
      'This period overlaps another assignment of the same person on this flat',
    )
    await audit(tx, ctx, 'RESIDENT_UPDATED', { societyId, flatId: assignment.flatId, assignmentId: id, changes: body })
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
 * `?status=PENDING` is the approval queue, `?active=true` who holds access right now.
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

  const rows = await db
    .select({
      assignment: flatResidents,
      user: userColumns,
      today: sql<string>`current_date`,
      flat: { id: flats.id, number: flats.number },
      block: { id: blocks.id, name: blocks.name },
    })
    .from(flatResidents)
    .innerJoin(flats, eq(flats.id, flatResidents.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(users, eq(users.id, flatResidents.userId))
    .where(and(...filters))
    .orderBy(desc(flatResidents.createdAt))
  return rows.map((row) => ({ ...view(row), flat: row.flat, block: row.block }))
}
