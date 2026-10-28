import { randomInt } from 'node:crypto'
import { and, asc, desc, eq, gt, gte, ilike, inArray, isNull, lt, lte, or, sql, type AnyColumn } from 'drizzle-orm'
import { db } from '../../db/client.js'
import {
  blocks,
  flatResidents,
  flats,
  floors,
  gates,
  guardGateAssignments,
  staff,
  staffAttendance,
  staffEntryRejections,
  staffFlats,
  staffLeave,
  users,
  visitorPasses,
  visits,
} from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import { enqueueNotification } from '../notification/outbox.service.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { requireFile } from '../file/file.service.js'
import { assertFlatAccess, assertSameSociety, assertState, deny, permissionDenied, requireRecord, UUID } from '../access/scope.js'
import { recordAuditEvent, type AuditEventType, type DbExecutor } from '../audit/audit.service.js'
import type {
  CreatePassBody,
  DecideVisitBody,
  ListVisitsQuery,
  RegisterVisitBody,
  StaffMovementBody,
  StaffMovementHistoryQuery,
  StaffRejectionBody,
} from './gate.schemas.js'

/** The approver's single reminder, and the point at which the guard decides instead. */
const REMINDER_AFTER_MS = 60_000
const ESCALATE_AFTER_MS = 180_000

const AWAITING_APPROVAL = 'AWAITING_APPROVAL'
const AWAITING_MANUAL = 'AWAITING_MANUAL'
const APPROVED = 'APPROVED'
const ENTERED = 'ENTERED'

/** YYYY-MM-DD as the society reads it; toISOString would shift the date behind UTC. */
const isoDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** Midnight to midnight for the day asked for, in the server's zone, which is the society's. */
function dayWindow(on?: string) {
  const from = on ? new Date(`${on}T00:00:00`) : new Date()
  from.setHours(0, 0, 0, 0)
  const to = new Date(from)
  to.setDate(to.getDate() + 1)
  return { from, to }
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

function audit(executor: DbExecutor, ctx: AuthContext, eventType: AuditEventType, metadata: Record<string, unknown>) {
  return recordAuditEvent(executor, { eventType, actorUserId: ctx.userId, metadata })
}

/** The flat behind an id, with its block and society, or 404 / 403 as the caller's society decides. */
async function loadFlat(executor: DbExecutor, ctx: AuthContext, flatId: string) {
  const [row] = UUID.test(flatId)
    ? await executor
        .select({
          id: flats.id,
          number: flats.number,
          societyId: blocks.societyId,
          blockName: blocks.name,
          floorLabel: floors.floorLabel,
          status: flats.status,
        })
        .from(flats)
        .innerJoin(blocks, eq(blocks.id, flats.blockId))
        .innerJoin(floors, eq(floors.id, flats.floorId))
        .where(eq(flats.id, flatId))
    : []
  return requireRecord(ctx, row, 'Flat')
}

/** Every flat the signed-in resident currently holds, whatever their access level. */
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

const place = { number: flats.number, blockName: blocks.name, floorLabel: floors.floorLabel }

/** The flat as every gate screen shows it: "A-101". */
const label = (row: { blockName: string; number: string }) => `${row.blockName}-${row.number}`

// ---------------------------------------------------------------------------
// Visitor passes
// ---------------------------------------------------------------------------

/** Six digits, unique inside the society. Collisions are rare and simply retried. */
async function insertWithCode<T>(insert: (code: string) => Promise<T>) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await insert(String(randomInt(100000, 1000000)))
    } catch (error) {
      const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code
      if (code !== '23505' || attempt === 4) throw error
    }
  }
  throw new AppError(500, 'INTERNAL_ERROR', 'Could not issue an entry code')
}

function serializePass(pass: typeof visitorPasses.$inferSelect, flat?: { blockName: string; number: string; floorLabel?: string }) {
  return { ...pass, people: Number(pass.people), flat: flat ? { ...flat, label: label(flat) } : undefined }
}

/** A resident pre-approves someone; the entry code is what the guard checks. */
export async function createPass(ctx: AuthContext, body: CreatePassBody & { flatId: string }) {
  const flat = await loadFlat(db, ctx, body.flatId)
  await assertFlatAccess(ctx, flat.id, { write: true })
  assertState(flat.status === 'ACTIVE', 'This flat is not active')

  const { flatId, ...rest } = body
  const pass = await insertWithCode(async (entryCode) => {
    const [row] = await db
      .insert(visitorPasses)
      .values({ ...rest, flatId, societyId: flat.societyId, createdBy: ctx.userId, entryCode })
      .returning()
    return row!
  })
  await audit(db, ctx, 'VISITOR_PASS_CREATED', { passId: pass.id, flat: label(flat), name: pass.visitorName })
  return serializePass(pass, flat)
}

export async function listMyPasses(ctx: AuthContext) {
  const flatIds = await myFlatIds(ctx)
  if (flatIds.length === 0) return []
  const rows = await db
    .select({ pass: visitorPasses, flat: place })
    .from(visitorPasses)
    .innerJoin(flats, eq(flats.id, visitorPasses.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(floors, eq(floors.id, flats.floorId))
    .where(inArray(visitorPasses.flatId, flatIds))
    .orderBy(desc(visitorPasses.validOn), desc(visitorPasses.createdAt))
    .limit(50)
  return rows.map((row) => serializePass(row.pass, row.flat))
}

export async function cancelPass(ctx: AuthContext, id: string) {
  const [existing] = UUID.test(id) ? await db.select().from(visitorPasses).where(eq(visitorPasses.id, id)) : []
  const pass = await requireRecord(ctx, existing, 'Pass')
  await assertFlatAccess(ctx, pass.flatId, { write: true })
  assertState(pass.status === 'ACTIVE', 'This pass is not active any more')

  const [updated] = await db
    .update(visitorPasses)
    .set({ status: 'CANCELLED', cancelledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(visitorPasses.id, id), eq(visitorPasses.status, 'ACTIVE')))
    .returning()
  assertState(Boolean(updated), 'This pass is not active any more')
  await audit(db, ctx, 'VISITOR_PASS_CANCELLED', { passId: id, name: pass.visitorName })
  return serializePass(updated!)
}

/** Why a pass cannot be used right now, or null when the guard may let them in. */
function passProblem(pass: typeof visitorPasses.$inferSelect, today: string, now: string) {
  if (pass.status === 'CANCELLED') return 'The resident cancelled this pass'
  if (pass.status === 'USED') return 'This pass has already been used'
  if (pass.validOn < today) return 'This pass expired'
  if (pass.validOn > today) return `This pass is only valid on ${pass.validOn}`
  if (now < pass.validFrom || now > pass.validUntil) return `This pass is valid between ${pass.validFrom} and ${pass.validUntil} today`
  return null
}

/** The guard types the six digits: either a usable pass with the flat behind it, or the reason it is refused. */
export async function validatePass(ctx: AuthContext, societyId: string, code: string) {
  await assertSameSociety(ctx, societyId)
  const [row] = await db
    .select({ pass: visitorPasses, flat: place, today: sql<string>`current_date::text`, now: sql<string>`to_char(now(), 'HH24:MI:SS')` })
    .from(visitorPasses)
    .innerJoin(flats, eq(flats.id, visitorPasses.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(floors, eq(floors.id, flats.floorId))
    .where(and(eq(visitorPasses.societyId, societyId), eq(visitorPasses.entryCode, code)))
    .orderBy(desc(visitorPasses.createdAt))
    .limit(1)

  if (!row) {
    await audit(db, ctx, 'VISITOR_PASS_REFUSED', { societyId, reason: 'NOT_FOUND' })
    return { valid: false as const, reason: 'No pass has this entry code', pass: null }
  }
  const problem = passProblem(row.pass, row.today, row.now)
  if (problem) await audit(db, ctx, 'VISITOR_PASS_REFUSED', { passId: row.pass.id, reason: problem })
  return { valid: !problem, reason: problem, pass: serializePass(row.pass, row.flat) }
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

const visitColumns = {
  visit: visits,
  flat: place,
  gateName: gates.name,
  passCode: visitorPasses.entryCode,
  registeredByName: users.name,
}

function visitQuery() {
  return db
    .select(visitColumns)
    .from(visits)
    .innerJoin(flats, eq(flats.id, visits.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(floors, eq(floors.id, flats.floorId))
    .leftJoin(gates, eq(gates.id, visits.gateId))
    .leftJoin(visitorPasses, eq(visitorPasses.id, visits.passId))
    .leftJoin(users, eq(users.id, visits.registeredBy))
    .$dynamic()
}

type VisitRow = { visit: typeof visits.$inferSelect; flat: { number: string; blockName: string; floorLabel: string }; gateName: string | null; passCode: string | null; registeredByName?: string | null }

const serializeVisit = (row: VisitRow) => ({
  ...row.visit,
  people: Number(row.visit.people),
  flat: { ...row.flat, label: label(row.flat) },
  gateName: row.gateName,
  passCode: row.passCode,
  registeredByName: row.registeredByName ?? null,
})

/**
 * Who is asked to approve a visit to this flat: the active tenant if there is one, otherwise the
 * owner, and only while they hold FULL access. An owner is VIEW_ONLY while a tenant is in place,
 * so they are never the approver then.
 *
 * Returns undefined when the flat has nobody who can answer. The visit then goes straight to the
 * guard rather than waiting three minutes for a decision that cannot come.
 */
export async function currentResidents(flatId: string) {
  return db
    .select({
      userId: flatResidents.userId,
      residentType: flatResidents.residentType,
      accessLevel: flatResidents.accessLevel,
      name: users.name,
    })
    .from(flatResidents)
    .innerJoin(users, eq(users.id, flatResidents.userId))
    .where(
      and(
        eq(flatResidents.flatId, flatId),
        eq(flatResidents.verificationStatus, 'VERIFIED'),
        eq(users.isActive, true),
        lte(flatResidents.startDate, sql`current_date`),
        or(isNull(flatResidents.endDate), gte(flatResidents.endDate, sql`current_date`))!,
      ),
    )
}

/** The one of them who answers for the flat, or undefined when nobody can. */
function approverAmong(rows: Awaited<ReturnType<typeof currentResidents>>) {
  const full = rows.filter((row) => row.accessLevel === 'FULL')
  return full.find((row) => row.residentType === 'TENANT') ?? full.find((row) => row.residentType === 'OWNER')
}

export async function effectiveApprover(flatId: string) {
  return approverAmong(await currentResidents(flatId))
}

/** Who answers this visit: the resident who was asked for, when they may, else the flat's approver. */
export async function approverFor(flatId: string, intendedResidentId?: string | null) {
  const rows = await currentResidents(flatId)
  return rows.find((row) => row.userId === intendedResidentId && row.accessLevel === 'FULL') ?? approverAmong(rows)
}

/**
 * The guard's form. With an entry code the visit is approved outright, since the resident
 * approved it when they issued the pass; without one it waits on the resident's answer - or goes
 * straight to the guard when the flat has nobody who can answer.
 */
export interface RegisterVisitOptions {
  /** Set when the visit is replayed from a guard's offline queue; unique, so a replay cannot duplicate it */
  clientEventId?: string
  /**
   * The guard admitted this visitor during an outage. The visit is recorded as physically inside
   * with no resident decision, flagged for the office, and timestamped when it actually happened.
   */
  manualOffline?: { reason: string; at: Date }
}

export async function registerVisit(
  ctx: AuthContext,
  societyId: string,
  body: RegisterVisitBody,
  { clientEventId, manualOffline }: RegisterVisitOptions = {},
) {
  await assertSameSociety(ctx, societyId)
  await assertGate(ctx, body.gateId)
  const flat = await loadFlat(db, ctx, body.flatId)
  assertState(flat.societyId === societyId, 'That flat belongs to another society')
  assertState(flat.status === 'ACTIVE', 'This flat is not active')
  // The gate photograph is required by the form; a reference that was never stored is not accepted
  if (body.photoReference) await requireFile(societyId, body.photoReference)
  const residents = await currentResidents(flat.id)
  if (body.intendedResidentId) {
    assertState(
      residents.some((resident) => resident.userId === body.intendedResidentId),
      'That resident does not live in this flat',
    )
  }

  let passId: string | null = null
  let status: typeof AWAITING_APPROVAL | typeof AWAITING_MANUAL | typeof APPROVED | typeof ENTERED = AWAITING_APPROVAL
  if (manualOffline) {
    status = ENTERED
  } else if (body.entryCode) {
    const checked = await validatePass(ctx, societyId, body.entryCode)
    if (!checked.valid) throw new AppError(400, 'INVALID_STATE', checked.reason ?? 'This pass cannot be used')
    assertState(checked.pass!.flatId === flat.id, 'That pass was issued for another flat')
    passId = checked.pass!.id
    status = APPROVED
  } else if (!approverAmong(residents)) {
    status = AWAITING_MANUAL
  }

  // The resident who was asked for answers for themselves, as long as they may; otherwise the
  // flat's usual approver does.
  const asked = residents.find((resident) => resident.userId === body.intendedResidentId && resident.accessLevel === 'FULL')
  const approver = status === AWAITING_APPROVAL ? (asked ?? approverAmong(residents)) : undefined
  const now = new Date()
  const { entryCode: _code, expectedDate, expectedTime, clientEventId: bodyEventId, flatId, ...rest } = body
  const [visit] = await unique(
    db
      .insert(visits)
      .values({
        ...rest,
        flatId,
        societyId,
        passId,
        status,
        expectedAt: expectedDate && expectedTime ? new Date(`${expectedDate}T${expectedTime}`) : now,
        clientEventId: clientEventId ?? bodyEventId,
        registeredBy: ctx.userId,
        ...(status === APPROVED ? { decidedBy: ctx.userId, decidedAt: new Date(), decisionReason: 'Arrived with a valid pass' } : {}),
        // One reminder a minute in, the guard's decision two minutes after that. Only a visit
        // that is actually waiting on someone has deadlines.
        ...(status === AWAITING_APPROVAL
          ? { reminderAt: new Date(now.getTime() + REMINDER_AFTER_MS), escalateAt: new Date(now.getTime() + ESCALATE_AFTER_MS) }
          : {}),
        // No decidedBy: nobody approved this, and the record must not suggest anyone did
        ...(manualOffline
          ? {
              source: 'MANUAL_OFFLINE' as const,
              needsReview: true,
              reviewReason: manualOffline.reason.slice(0, 120),
              enteredAt: manualOffline.at,
              entryBy: ctx.userId,
            }
          : {}),
      })
      .returning(),
    'This visit is already registered',
  )
  const label_ = label(flat)
  if (approver) {
    await enqueueNotification(db, {
      societyId,
      eventType: 'VISITOR_WAITING_APPROVAL',
      entityType: 'visit',
      entityId: visit!.id,
      recipientIds: [approver.userId],
      payload: { name: visit!.visitorName, flat: label_, purpose: visit!.purpose },
    })
  } else if (status === AWAITING_MANUAL) {
    // Nobody can answer, so the gate and the office are told rather than a resident
    await enqueueNotification(db, {
      societyId,
      eventType: 'VISITOR_ESCALATED_TO_GATE',
      entityType: 'visit',
      entityId: visit!.id,
      recipientIds: [ctx.userId],
      payload: { name: visit!.visitorName, flat: label_ },
    })
  }
  if (manualOffline) {
    await enqueueNotification(db, {
      societyId,
      eventType: 'OFFLINE_EVENT_NEEDS_REVIEW',
      entityType: 'visit',
      entityId: visit!.id,
      recipientIds: [ctx.userId],
      payload: { name: visit!.visitorName, flat: label_ },
    })
  }
  await audit(db, ctx, manualOffline ? 'VISIT_MANUAL_OFFLINE_ENTRY' : 'VISIT_REGISTERED', {
    visitId: visit!.id,
    flat: label(flat),
    name: visit!.visitorName,
    status,
    ...(manualOffline ? { reason: manualOffline.reason, recordedAt: manualOffline.at.toISOString() } : {}),
  })
  return serializeVisit({ visit: visit!, flat, gateName: null, passCode: body.entryCode ?? null })
}

/** The gate's list: today by default, newest first. */
export async function listVisits(ctx: AuthContext, societyId: string, query: ListVisitsQuery) {
  await assertSameSociety(ctx, societyId)
  const filters = [eq(visits.societyId, societyId)]
  if (query.status) filters.push(eq(visits.status, query.status))
  if (query.gateId) filters.push(eq(visits.gateId, query.gateId))
  if (query.flatId) filters.push(eq(visits.flatId, query.flatId))
  // ENTERED is "who is here now", which has no date; every other view is one day's gate log
  if (query.status !== ENTERED) filters.push(sql`${visits.createdAt} >= ${query.date ?? sql`current_date`}::date`)
  if (query.date) filters.push(sql`${visits.createdAt} < (${query.date}::date + 1)`)
  if (query.search) {
    const term = `%${query.search}%`
    filters.push(
      or(ilike(visits.visitorName, term), ilike(visits.visitorPhone, term), ilike(sql`${blocks.name} || '-' || ${flats.number}`, term))!,
    )
  }
  const rows = await visitQuery().where(and(...filters)).orderBy(desc(visits.createdAt)).limit(100)
  return rows.map(serializeVisit)
}

/** A returning visitor: the guard types the mobile and the rest fills itself in. */
export async function lookupVisitor(ctx: AuthContext, societyId: string, phone: string) {
  await assertSameSociety(ctx, societyId)
  const [row] = await visitQuery()
    .where(and(eq(visits.societyId, societyId), eq(visits.visitorPhone, phone)))
    .orderBy(desc(visits.createdAt))
    .limit(1)
  if (!row) return null
  const visit = serializeVisit(row)
  return {
    visitorName: visit.visitorName,
    visitorPhone: visit.visitorPhone,
    purpose: visit.purpose,
    company: visit.company,
    vehicleNumber: visit.vehicleNumber,
    photoReference: visit.photoReference,
    lastVisit: { at: visit.createdAt, flat: visit.flat.label },
  }
}

/** Everything the resident's app shows: their flats' visits, the ones waiting first. */
export async function listMyVisits(ctx: AuthContext) {
  const flatIds = await myFlatIds(ctx)
  if (flatIds.length === 0) return []
  const rows = await visitQuery()
    .where(inArray(visits.flatId, flatIds))
    .orderBy(sql`case when ${visits.status} = 'AWAITING_APPROVAL' then 0 else 1 end`, desc(visits.createdAt))
    .limit(50)
  return rows.map(serializeVisit)
}

async function loadVisit(ctx: AuthContext, id: string) {
  const [row] = UUID.test(id) ? await visitQuery().where(eq(visits.id, id)) : []
  await requireRecord(ctx, row?.visit, 'Visit')
  return row!
}

/**
 * The answer to "someone is at the gate for you". A resident with FULL access to the flat
 * decides, and a guard holding VISIT_DECIDE may decide after the intercom call goes unanswered.
 */
export async function decideVisit(ctx: AuthContext, id: string, body: DecideVisitBody) {
  const row = await loadVisit(ctx, id)
  const asGuard = ctx.permissions?.includes('VISIT_DECIDE') ?? false
  if (!asGuard) await assertFlatAccess(ctx, row.visit.flatId, { write: true })

  // A resident answers while the visit is waiting on them. Once it has escalated the decision is
  // the guard's, and the guard has to say why, because nobody upstairs was asked.
  const open: ('AWAITING_APPROVAL' | 'AWAITING_MANUAL')[] = asGuard ? [AWAITING_APPROVAL, AWAITING_MANUAL] : [AWAITING_APPROVAL]
  assertState(open.some((status) => status === row.visit.status), 'This visit has already been decided')
  if (asGuard && row.visit.status === AWAITING_MANUAL) {
    assertState(Boolean(body.reason), 'Give the reason for deciding this at the gate')
  }

  const [updated] = await db
    .update(visits)
    .set({
      status: body.decision,
      decidedBy: ctx.userId,
      decidedAt: new Date(),
      decisionReason: body.reason ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(visits.id, id), inArray(visits.status, open)))
    .returning()
  assertState(Boolean(updated), 'This visit has already been decided')
  await audit(db, ctx, 'VISIT_DECIDED', {
    visitId: id,
    flat: label(row.flat),
    name: row.visit.visitorName,
    decision: body.decision,
    ...(asGuard ? { byGuard: true } : {}),
    ...(body.reason ? { reason: body.reason } : {}),
  })
  // The gate needs the answer, and the flat needs to know what was decided in its name
  await enqueueNotification(db, {
    societyId: row.visit.societyId,
    eventType: 'VISITOR_DECIDED',
    entityType: 'visit',
    entityId: id,
    recipientIds: await flatAudience(row.visit.flatId, row.visit.registeredBy, ctx.userId),
    payload: { name: row.visit.visitorName, flat: label(row.flat), status: body.decision },
  })
  return serializeVisit({ ...row, visit: updated! })
}

/**
 * Who hears about something that happened at a flat: the residents who hold access, plus the
 * guard who registered it. The person who caused it is left out - they just did it and watched
 * it happen - and nobody is told twice.
 */
async function flatAudience(flatId: string, ...extra: (string | null | undefined)[]) {
  const residents = await db
    .select({ userId: flatResidents.userId })
    .from(flatResidents)
    .innerJoin(users, eq(users.id, flatResidents.userId))
    .where(
      and(
        eq(flatResidents.flatId, flatId),
        eq(flatResidents.verificationStatus, 'VERIFIED'),
        eq(users.isActive, true),
        lte(flatResidents.startDate, sql`current_date`),
        or(isNull(flatResidents.endDate), gte(flatResidents.endDate, sql`current_date`))!,
      ),
    )
  const actor = extra.at(-1)
  return [...new Set([...residents.map((row) => row.userId), ...extra.filter((id): id is string => Boolean(id))])].filter(
    (id) => id !== actor,
  )
}

/** The gate lets them in. A one-entry pass is closed here, so it cannot be used twice. */
export async function recordEntry(ctx: AuthContext, id: string, gateId?: string) {
  const row = await loadVisit(ctx, id)
  await assertSameSociety(ctx, row.visit.societyId)
  await assertGate(ctx, gateId ?? row.visit.gateId ?? undefined)
  assertState(row.visit.status === APPROVED, 'Only an approved visit can be let in')

  const entered = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(visits)
      .set({ status: ENTERED, enteredAt: new Date(), entryBy: ctx.userId, gateId: gateId ?? row.visit.gateId, updatedAt: new Date() })
      .where(and(eq(visits.id, id), eq(visits.status, APPROVED)))
      .returning()
    if (!updated) return null
    if (row.visit.passId) {
      await tx
        .update(visitorPasses)
        .set({ status: 'USED', usedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(visitorPasses.id, row.visit.passId), eq(visitorPasses.passType, 'ONE_ENTRY'), eq(visitorPasses.status, 'ACTIVE')))
    }
    await audit(tx, ctx, 'VISIT_ENTRY_RECORDED', { visitId: id, flat: label(row.flat), name: row.visit.visitorName })
    await enqueueNotification(tx, {
      societyId: row.visit.societyId,
      eventType: 'VISITOR_ENTERED',
      entityType: 'visit',
      entityId: id,
      recipientIds: await flatAudience(row.visit.flatId, ctx.userId),
      payload: { name: row.visit.visitorName, flat: label(row.flat) },
    })
    return updated
  })
  assertState(Boolean(entered), 'Only an approved visit can be let in')
  return serializeVisit({ ...row, visit: entered! })
}

export async function recordExit(ctx: AuthContext, id: string) {
  const row = await loadVisit(ctx, id)
  await assertSameSociety(ctx, row.visit.societyId)
  assertState(row.visit.status === ENTERED, 'This visitor is not inside')

  const [updated] = await db
    .update(visits)
    .set({ status: 'CLOSED', exitedAt: new Date(), exitBy: ctx.userId, updatedAt: new Date() })
    .where(and(eq(visits.id, id), eq(visits.status, ENTERED)))
    .returning()
  assertState(Boolean(updated), 'This visitor is not inside')
  await audit(db, ctx, 'VISIT_EXIT_RECORDED', { visitId: id, flat: label(row.flat), name: row.visit.visitorName })
  await enqueueNotification(db, {
    societyId: row.visit.societyId,
    eventType: 'VISITOR_EXITED',
    entityType: 'visit',
    entityId: id,
    recipientIds: await flatAudience(row.visit.flatId, ctx.userId),
    payload: { name: row.visit.visitorName, flat: label(row.flat) },
  })
  return serializeVisit({ ...row, visit: updated! })
}

// ---------------------------------------------------------------------------
// Staff at the gate
// ---------------------------------------------------------------------------

/** Which flats a staff member serves, as the gate screen lists them. */
async function flatsServedBy(staffIds: string[]) {
  if (staffIds.length === 0) return []
  return db
    .select({ staffId: staffFlats.staffId, flatId: flats.id, number: flats.number, blockName: blocks.name, timeWindow: staffFlats.timeWindow })
    .from(staffFlats)
    .innerJoin(flats, eq(flats.id, staffFlats.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .where(inArray(staffFlats.staffId, staffIds))
    .orderBy(asc(blocks.name), asc(flats.number))
}

/** The open attendance row, when the staff member is inside right now. */
async function openAttendance(staffIds: string[]) {
  if (staffIds.length === 0) return []
  return db
    .select({ id: staffAttendance.id, staffId: staffAttendance.staffId, enteredAt: staffAttendance.enteredAt })
    .from(staffAttendance)
    .where(and(inArray(staffAttendance.staffId, staffIds), isNull(staffAttendance.exitedAt)))
}

/** The guard types the pass number: the person, their flats, and whether the pass is still good. */
export async function staffByPassCode(ctx: AuthContext, societyId: string, passCode: string) {
  await assertSameSociety(ctx, societyId)
  const [row] = await db
    .select({ staff, today: sql<string>`current_date::text` })
    .from(staff)
    .where(and(eq(staff.societyId, societyId), eq(staff.passCode, passCode.trim().toUpperCase())))
  if (!row) {
    await audit(db, ctx, 'STAFF_PASS_REFUSED', { societyId, reason: 'NOT_FOUND' })
    return { valid: false as const, reason: 'No staff member has this pass number', staff: null }
  }
  const member = row.staff
  const problem =
    member.status !== 'ACTIVE'
      ? 'This pass was cancelled'
      : member.passValidFrom > row.today
        ? `This pass starts on ${member.passValidFrom}`
        : member.passValidUntil && member.passValidUntil < row.today
          ? 'This pass expired'
          : null
  if (problem) await audit(db, ctx, 'STAFF_PASS_REFUSED', { staffId: member.id, reason: problem })

  const [served, open] = await Promise.all([flatsServedBy([member.id]), openAttendance([member.id])])
  const { idDocumentHash: _hash, ...safe } = member
  return {
    valid: !problem,
    reason: problem,
    staff: {
      ...safe,
      idDocumentOnFile: Boolean(member.idDocumentHash),
      flatsServed: served.map((flat) => ({ ...flat, label: `${flat.blockName}-${flat.number}` })),
      inside: open.length > 0,
      enteredAt: open[0]?.enteredAt ?? null,
    },
  }
}

async function loadStaff(ctx: AuthContext, id: string) {
  const [row] = UUID.test(id) ? await db.select().from(staff).where(eq(staff.id, id)) : []
  return requireRecord(ctx, row, 'Staff member')
}

/** The gate the movement happened at must be one of this society's, and still in use. */
async function assertGate(ctx: AuthContext, gateId?: string) {
  if (!gateId) return
  const [gate] = UUID.test(gateId) ? await db.select({ societyId: gates.societyId, status: gates.status }).from(gates).where(eq(gates.id, gateId)) : []
  await requireRecord(ctx, gate, 'Gate')
  assertState(gate!.status === 'ACTIVE', 'This gate is not in use')
  await assertGateAssigned(ctx, gateId)
}

/**
 * A guard works only the gates they are posted to. Anyone else with a gate permission - the
 * office, a committee member reading the log - is not posted anywhere, so the check is for guards.
 *
 * A guard with no posting at all is left alone: a society that has not started assigning gates
 * would otherwise lock its own guards out of the gate.
 */
export async function assertGateAssigned(ctx: AuthContext, gateId: string) {
  if (ctx.role !== 'GUARD') return
  const postings = await db
    .select({ gateId: guardGateAssignments.gateId })
    .from(guardGateAssignments)
    .where(
      and(
        eq(guardGateAssignments.guardUserId, ctx.userId),
        lte(guardGateAssignments.startAt, sql`now()`),
        or(isNull(guardGateAssignments.endAt), gt(guardGateAssignments.endAt, sql`now()`))!,
      ),
    )
  if (postings.length === 0) return
  if (!postings.some((posting) => posting.gateId === gateId)) {
    throw new AppError(403, 'GATE_ACCESS_DENIED', 'You are not posted to this gate')
  }
}

/**
 * SMB-52 hears that a staff member moved: one event per flat they serve, to the residents who
 * hold that flat. Enqueuing is a row in the outbox, so a failing channel later never reaches the
 * movement that is already recorded. A staff member who serves no flat has nobody to tell.
 */
async function announceStaffMovement(ctx: AuthContext, member: typeof staff.$inferSelect, eventType: 'STAFF_ENTERED' | 'STAFF_EXITED', attendanceId: string) {
  const served = await flatsServedBy([member.id])
  for (const flat of served) {
    await enqueueNotification(db, {
      societyId: member.societyId,
      eventType,
      entityType: 'staff',
      entityId: attendanceId,
      recipientIds: await flatAudience(flat.flatId, ctx.userId),
      payload: { name: member.name, flat: `${flat.blockName}-${flat.number}` },
    })
  }
}

/** The movement a request id already produced, so a retry of the same tap is answered, not repeated. */
async function movementFor(staffId: string, key: string | undefined, column: AnyColumn) {
  if (!key) return undefined
  const [row] = await db.select().from(staffAttendance).where(and(eq(staffAttendance.staffId, staffId), eq(column, key)))
  return row
}

/**
 * Records the staff member in. The open-row index does the deciding, so two guards scanning at the
 * same moment produce one entry and one "already inside" rather than two rows.
 */
export async function recordStaffEntry(ctx: AuthContext, id: string, body: StaffMovementBody = {}) {
  const member = await loadStaff(ctx, id)
  await assertGate(ctx, body.gateId)

  const already = await movementFor(id, body.idempotencyKey, staffAttendance.entryKey)
  if (already) return already

  assertState(member.status === 'ACTIVE', 'This staff member is not active')
  const [row] = await unique(
    db
      .insert(staffAttendance)
      .values({ staffId: id, gateId: body.gateId ?? null, entryBy: ctx.userId, entryKey: body.idempotencyKey ?? null })
      .returning(),
    'This staff member is already inside',
  )
  await audit(db, ctx, 'STAFF_ENTRY_RECORDED', { staffId: id, name: member.name, gateId: body.gateId ?? null })
  await announceStaffMovement(ctx, member, 'STAFF_ENTERED', row!.id)
  return row!
}

export async function recordStaffExit(ctx: AuthContext, id: string, body: StaffMovementBody = {}) {
  const member = await loadStaff(ctx, id)
  await assertGate(ctx, body.gateId)

  const already = await movementFor(id, body.idempotencyKey, staffAttendance.exitKey)
  if (already) return already

  // The condition is part of the update, so the row only closes once however many requests arrive
  const [row] = await db
    .update(staffAttendance)
    .set({ exitedAt: new Date(), exitBy: ctx.userId, exitKey: body.idempotencyKey ?? null, ...(body.gateId ? { gateId: body.gateId } : {}) })
    .where(and(eq(staffAttendance.staffId, id), isNull(staffAttendance.exitedAt)))
    .returning()
  assertState(Boolean(row), 'This staff member is not inside')
  await audit(db, ctx, 'STAFF_EXIT_RECORDED', { staffId: id, name: member.name, gateId: body.gateId ?? null })
  await announceStaffMovement(ctx, member, 'STAFF_EXITED', row!.id)
  return row!
}

/**
 * The guard refused the entry. No attendance row is created, so the refusal and its reason are
 * kept in their own record and read back beside the entries and exits.
 */
export async function rejectStaffEntry(ctx: AuthContext, id: string, body: StaffRejectionBody) {
  const member = await loadStaff(ctx, id)
  await assertGate(ctx, body.gateId)

  if (body.idempotencyKey) {
    const [already] = await db
      .select()
      .from(staffEntryRejections)
      .where(and(eq(staffEntryRejections.staffId, id), eq(staffEntryRejections.idempotencyKey, body.idempotencyKey)))
    if (already) return already
  }

  const [row] = await unique(
    db
      .insert(staffEntryRejections)
      .values({
        staffId: id,
        gateId: body.gateId ?? null,
        reason: body.reason,
        note: body.note ?? null,
        rejectedBy: ctx.userId,
        idempotencyKey: body.idempotencyKey ?? null,
      })
      .returning(),
    'This refusal was already recorded',
  )
  await audit(db, ctx, 'STAFF_ENTRY_REJECTED', { staffId: id, name: member.name, reason: body.reason, gateId: body.gateId ?? null })
  return row!
}

/**
 * What the guard is shown before recording anything: who this is, whether the profile still allows
 * entry, and whether they are already inside. The identity hash and home address never leave.
 */
export async function staffVerification(ctx: AuthContext, id: string) {
  const member = await loadStaff(ctx, id)
  const [served, open] = await Promise.all([flatsServedBy([id]), openAttendance([id])])
  const passExpired = member.passValidUntil !== null && member.passValidUntil < isoDay(new Date())
  const inside = open.length > 0
  return {
    staffId: member.id,
    name: member.name,
    phone: member.phone,
    staffType: member.workType ?? member.kind,
    kind: member.kind,
    photoReference: member.photoReference,
    policeVerification: member.policeVerification,
    active: member.status === 'ACTIVE',
    passCode: member.passCode,
    passValidUntil: member.passValidUntil,
    currentlyInside: inside,
    movementState: inside ? ('ENTERED' as const) : ('NOT_INSIDE' as const),
    enteredAt: open[0]?.enteredAt ?? null,
    flatsServed: served.filter((flat) => flat.staffId === id).map((flat) => ({ ...flat, label: `${flat.blockName}-${flat.number}` })),
    /** Why entry cannot be recorded, or null when it can */
    blockedReason: member.status !== 'ACTIVE' ? 'STAFF_INACTIVE' : passExpired ? 'INVALID_PASS' : inside ? 'ALREADY_INSIDE' : null,
  }
}

/** Staff inside right now, without the visitors the gate screen mixes them with. */
export async function staffInside(ctx: AuthContext, societyId: string) {
  await assertSameSociety(ctx, societyId)
  const rows = await db
    .select({ attendance: staffAttendance, staff, gateName: gates.name })
    .from(staffAttendance)
    .innerJoin(staff, eq(staff.id, staffAttendance.staffId))
    .leftJoin(gates, eq(gates.id, staffAttendance.gateId))
    .where(and(eq(staff.societyId, societyId), isNull(staffAttendance.exitedAt)))
    .orderBy(desc(staffAttendance.enteredAt))
  const served = await flatsServedBy(rows.map((row) => row.staff.id))
  return rows.map((row) => ({
    staffId: row.staff.id,
    name: row.staff.name,
    staffType: row.staff.workType ?? row.staff.kind,
    kind: row.staff.kind,
    enteredAt: row.attendance.enteredAt,
    gateName: row.gateName,
    flats: served.filter((flat) => flat.staffId === row.staff.id).map((flat) => `${flat.blockName}-${flat.number}`),
  }))
}

export interface StaffMovement {
  id: string
  staffId: string
  name: string
  staffType: string
  kind: string
  eventType: 'ENTRY' | 'EXIT' | 'ENTRY_REJECTED'
  verificationStatus: 'VERIFIED' | 'REJECTED'
  at: Date
  gateName: string | null
  performedBy: string | null
  rejectionReason: string | null
  rejectionNote: string | null
}

/**
 * Entries, exits and refusals as one list, newest first. An attendance row is two events, which is
 * why the page is cut after the rows are merged rather than in the query.
 */
export async function staffMovementHistory(ctx: AuthContext, societyId: string, query: StaffMovementHistoryQuery) {
  await assertSameSociety(ctx, societyId)
  const limit = query.limit ?? 50
  const offset = query.offset ?? 0
  const from = query.dateFrom ? new Date(`${query.dateFrom}T00:00:00`) : undefined
  const to = query.dateTo ? dayWindow(query.dateTo).to : undefined

  const staffFilters = [eq(staff.societyId, societyId)]
  if (query.staffId) staffFilters.push(eq(staff.id, query.staffId))
  if (query.staffType) staffFilters.push(or(ilike(staff.workType, query.staffType), eq(sql`${staff.kind}::text`, query.staffType))!)

  const wantsVerified = query.verificationStatus !== 'REJECTED'
  const wantsRejected = query.verificationStatus !== 'VERIFIED' && query.eventType !== 'ENTRY' && query.eventType !== 'EXIT'

  const [sessions, rejections] = await Promise.all([
    wantsVerified
      ? db
          .select({ attendance: staffAttendance, staff, gateName: gates.name, entryByName: users.name })
          .from(staffAttendance)
          .innerJoin(staff, eq(staff.id, staffAttendance.staffId))
          .leftJoin(gates, eq(gates.id, staffAttendance.gateId))
          .leftJoin(users, eq(users.id, staffAttendance.entryBy))
          .where(and(...staffFilters, ...(query.gateId ? [eq(staffAttendance.gateId, query.gateId)] : [])))
          .orderBy(desc(staffAttendance.enteredAt))
          .limit(limit + offset + 1)
      : [],
    wantsRejected
      ? db
          .select({ rejection: staffEntryRejections, staff, gateName: gates.name, byName: users.name })
          .from(staffEntryRejections)
          .innerJoin(staff, eq(staff.id, staffEntryRejections.staffId))
          .leftJoin(gates, eq(gates.id, staffEntryRejections.gateId))
          .leftJoin(users, eq(users.id, staffEntryRejections.rejectedBy))
          .where(and(...staffFilters, ...(query.gateId ? [eq(staffEntryRejections.gateId, query.gateId)] : [])))
          .orderBy(desc(staffEntryRejections.rejectedAt))
          .limit(limit + offset + 1)
      : [],
  ])

  const events: StaffMovement[] = []
  for (const row of sessions) {
    const common = {
      id: row.attendance.id,
      staffId: row.staff.id,
      name: row.staff.name,
      staffType: row.staff.workType ?? row.staff.kind,
      kind: row.staff.kind,
      verificationStatus: 'VERIFIED' as const,
      gateName: row.gateName,
      performedBy: row.entryByName,
      rejectionReason: null,
      rejectionNote: null,
    }
    if (query.eventType !== 'EXIT') events.push({ ...common, eventType: 'ENTRY', at: row.attendance.enteredAt })
    if (row.attendance.exitedAt && query.eventType !== 'ENTRY') events.push({ ...common, eventType: 'EXIT', at: row.attendance.exitedAt })
  }
  for (const row of rejections) {
    events.push({
      id: row.rejection.id,
      staffId: row.staff.id,
      name: row.staff.name,
      staffType: row.staff.workType ?? row.staff.kind,
      kind: row.staff.kind,
      eventType: 'ENTRY_REJECTED',
      verificationStatus: 'REJECTED',
      at: row.rejection.rejectedAt,
      gateName: row.gateName,
      performedBy: row.byName,
      rejectionReason: row.rejection.reason,
      rejectionNote: row.rejection.note,
    })
  }

  const inRange = events.filter((event) => (!from || event.at >= from) && (!to || event.at < to))
  inRange.sort((a, b) => b.at.getTime() - a.at.getTime())
  return { total: inRange.length, movements: inRange.slice(offset, offset + limit) }
}

/** The daily help panel in the resident's app: who works here, and where they are today. */
export async function listMyDailyHelp(ctx: AuthContext) {
  const flatIds = await myFlatIds(ctx)
  if (flatIds.length === 0) return []
  const rows = await db
    .selectDistinctOn([staff.id], { staff, flatId: staffFlats.flatId, timeWindow: staffFlats.timeWindow })
    .from(staffFlats)
    .innerJoin(staff, eq(staff.id, staffFlats.staffId))
    .where(and(inArray(staffFlats.flatId, flatIds), eq(staff.status, 'ACTIVE')))
    .orderBy(asc(staff.id))

  const ids = rows.map((row) => row.staff.id)
  const [open, leave, lastVisits] = await Promise.all([
    openAttendance(ids),
    ids.length
      ? db.select().from(staffLeave).where(and(inArray(staffLeave.staffId, ids), eq(staffLeave.onDate, sql`current_date`)))
      : [],
    ids.length
      ? db
          .selectDistinctOn([staffAttendance.staffId], { staffId: staffAttendance.staffId, enteredAt: staffAttendance.enteredAt, exitedAt: staffAttendance.exitedAt })
          .from(staffAttendance)
          .where(inArray(staffAttendance.staffId, ids))
          .orderBy(asc(staffAttendance.staffId), desc(staffAttendance.enteredAt))
      : [],
  ])

  return rows
    .map(({ staff: member, timeWindow }) => {
      const { idDocumentHash: _hash, ...safe } = member
      const inside = open.find((row) => row.staffId === member.id)
      const last = lastVisits.find((row) => row.staffId === member.id)
      return {
        ...safe,
        idDocumentOnFile: Boolean(member.idDocumentHash),
        timeWindow,
        inside: Boolean(inside),
        enteredAt: inside?.enteredAt ?? null,
        onLeaveToday: leave.some((row) => row.staffId === member.id),
        lastSeen: last ? { enteredAt: last.enteredAt, exitedAt: last.exitedAt } : null,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The attendance history behind "See attendance", newest first. */
export async function listStaffAttendance(ctx: AuthContext, staffId: string, days = 14) {
  const member = await loadStaff(ctx, staffId)
  await assertMayManageHelp(ctx, member.id, member.societyId)
  const rows = await db
    .select()
    .from(staffAttendance)
    .where(and(eq(staffAttendance.staffId, staffId), gte(staffAttendance.enteredAt, sql`now() - make_interval(days => ${days})`)))
    .orderBy(desc(staffAttendance.enteredAt))
    .limit(60)
  const leave = await db
    .select()
    .from(staffLeave)
    .where(and(eq(staffLeave.staffId, staffId), gte(staffLeave.onDate, sql`current_date - make_interval(days => ${days})`)))
    .orderBy(desc(staffLeave.onDate))
  return { attendance: rows, leave }
}

/** A resident may only touch staff who serve one of their own flats; the office may touch any. */
async function assertMayManageHelp(ctx: AuthContext, staffId: string, societyId: string) {
  if (ctx.permissions?.includes('STAFF_MANAGE')) return assertSameSociety(ctx, societyId)
  const flatIds = await myFlatIds(ctx)
  const served = flatIds.length
    ? await db
        .select({ flatId: staffFlats.flatId })
        .from(staffFlats)
        .where(and(eq(staffFlats.staffId, staffId), inArray(staffFlats.flatId, flatIds)))
    : []
  if (served.length === 0) throw await deny(ctx.userId, permissionDenied(), { staffId })
}

/** "Not coming today", from the flat the staff member works for. */
export async function markStaffLeave(ctx: AuthContext, staffId: string, onDate?: string) {
  const member = await loadStaff(ctx, staffId)
  await assertMayManageHelp(ctx, member.id, member.societyId)
  const [row] = await db
    .insert(staffLeave)
    .values({ staffId, onDate: onDate ?? sql`current_date`, markedBy: ctx.userId })
    .onConflictDoNothing()
    .returning()
  await audit(db, ctx, 'STAFF_LEAVE_MARKED', { staffId, name: member.name, onDate: onDate ?? 'today' })
  return row ?? { staffId, onDate: onDate ?? null, markedBy: ctx.userId }
}

/**
 * "Inside the premises now": visitors and staff in one list, because the guard thinks of the
 * gate as one place rather than two tables.
 */
export async function listInside(ctx: AuthContext, societyId: string) {
  await assertSameSociety(ctx, societyId)
  const [visitorRows, staffRows] = await Promise.all([
    visitQuery().where(and(eq(visits.societyId, societyId), eq(visits.status, ENTERED))).orderBy(desc(visits.enteredAt)),
    db
      .select({ attendance: staffAttendance, staff, gateName: gates.name })
      .from(staffAttendance)
      .innerJoin(staff, eq(staff.id, staffAttendance.staffId))
      .leftJoin(gates, eq(gates.id, staffAttendance.gateId))
      .where(and(eq(staff.societyId, societyId), isNull(staffAttendance.exitedAt)))
      .orderBy(desc(staffAttendance.enteredAt)),
  ])

  const served = await flatsServedBy(staffRows.map((row) => row.staff.id))
  const people = [
    ...visitorRows.map((row) => {
      const visit = serializeVisit(row)
      return {
        id: visit.id,
        kind: 'VISITOR' as const,
        name: visit.visitorName,
        type: visit.purpose,
        flat: visit.flat.label,
        enteredAt: visit.enteredAt,
        vehicleNumber: visit.vehicleNumber,
        gateName: visit.gateName,
      }
    }),
    ...staffRows.map((row) => ({
      id: row.staff.id,
      kind: 'STAFF' as const,
      name: row.staff.name,
      type: row.staff.kind,
      flat: served
        .filter((flat) => flat.staffId === row.staff.id)
        .map((flat) => `${flat.blockName}-${flat.number}`)
        .join(', '),
      enteredAt: row.attendance.enteredAt,
      vehicleNumber: null,
      gateName: row.gateName,
    })),
  ]
  return people.sort((a, b) => (b.enteredAt?.getTime() ?? 0) - (a.enteredAt?.getTime() ?? 0))
}

/**
 * The flat picker on the guard's form: the flat label and the resident's first name only, which
 * is all a guard needs to say "A-101, Riya?" and nothing more about who lives there.
 */
export async function flatDirectory(ctx: AuthContext, societyId: string) {
  await assertSameSociety(ctx, societyId)
  const rows = await db
    .select({
      id: flats.id,
      number: flats.number,
      blockName: blocks.name,
      // The guard picks the resident the visitor asked for out of this, so each one needs an id
      residents: sql<
        { id: string; name: string }[]
      >`coalesce(jsonb_agg(distinct jsonb_build_object('id', ${users.id}, 'name', ${users.name})) filter (where ${users.id} is not null), '[]')`,
    })
    .from(flats)
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .leftJoin(
      flatResidents,
      and(
        eq(flatResidents.flatId, flats.id),
        eq(flatResidents.verificationStatus, 'VERIFIED'),
        lte(flatResidents.startDate, sql`current_date`),
        or(isNull(flatResidents.endDate), gte(flatResidents.endDate, sql`current_date`)),
      ),
    )
    .leftJoin(users, eq(users.id, flatResidents.userId))
    .where(and(eq(blocks.societyId, societyId), eq(flats.status, 'ACTIVE')))
    .groupBy(flats.id, flats.number, blocks.name)
    .orderBy(asc(blocks.name), asc(flats.number))
  return rows.map((row) => ({ id: row.id, label: `${row.blockName}-${row.number}`, residents: row.residents }))
}

/** The three numbers on the guard's overview. */
export async function gateSummary(ctx: AuthContext, societyId: string) {
  await assertSameSociety(ctx, societyId)
  const [row] = await db
    .select({
      waiting: sql<number>`count(*) filter (where ${visits.status} = 'AWAITING_APPROVAL')`,
      inside: sql<number>`count(*) filter (where ${visits.status} = 'ENTERED')`,
      today: sql<number>`count(*) filter (where ${visits.createdAt} >= current_date)`,
    })
    .from(visits)
    .where(eq(visits.societyId, societyId))
  const [staffInside] = await db
    .select({ inside: sql<number>`count(*)` })
    .from(staffAttendance)
    .innerJoin(staff, eq(staff.id, staffAttendance.staffId))
    .where(and(eq(staff.societyId, societyId), isNull(staffAttendance.exitedAt)))
  const [expected] = await db
    .select({ passes: sql<number>`count(*)` })
    .from(visitorPasses)
    .where(and(eq(visitorPasses.societyId, societyId), eq(visitorPasses.status, 'ACTIVE'), eq(visitorPasses.validOn, sql`current_date`)))

  return {
    waiting: Number(row?.waiting ?? 0),
    inside: Number(row?.inside ?? 0) + Number(staffInside?.inside ?? 0),
    visitorsInside: Number(row?.inside ?? 0),
    staffInside: Number(staffInside?.inside ?? 0),
    today: Number(row?.today ?? 0),
    expected: Number(expected?.passes ?? 0),
  }
}

export interface Movement {
  /** The visit or attendance row the movement came from; an entry and its exit share it */
  id: string
  kind: 'VISITOR' | 'STAFF'
  direction: 'IN' | 'OUT'
  at: Date
  name: string
  /** The visit's purpose, or the staff member's kind */
  type: string
  flat: string
  gateName: string | null
  vehicleNumber: string | null
}

/**
 * One day at the gate: every entry and exit in the order they happened, and the numbers a guard
 * is asked for at the end of a shift. "Who is inside now" lives on the gate screen; this is the
 * record of the day, including the people still inside from before it started.
 */
export async function gateLog(ctx: AuthContext, societyId: string, on?: string) {
  await assertSameSociety(ctx, societyId)
  const { from, to } = dayWindow(on)
  const movedOrOpen = (entered: AnyColumn, exited: AnyColumn) =>
    or(and(gte(entered, from), lt(entered, to)), and(gte(exited, from), lt(exited, to)), and(isNull(exited), lt(entered, to)))

  const [visitorRows, staffRows] = await Promise.all([
    visitQuery()
      .where(
        and(
          eq(visits.societyId, societyId),
          or(
            movedOrOpen(visits.enteredAt, visits.exitedAt),
            // Turned away at the gate: no entry to record, but the guard still answers for it
            and(inArray(visits.status, ['DENIED', 'LEAVE_AT_GATE']), gte(visits.decidedAt, from), lt(visits.decidedAt, to)),
          ),
        ),
      )
      .orderBy(desc(visits.enteredAt)),
    db
      .select({ attendance: staffAttendance, staff, gateName: gates.name })
      .from(staffAttendance)
      .innerJoin(staff, eq(staff.id, staffAttendance.staffId))
      .leftJoin(gates, eq(gates.id, staffAttendance.gateId))
      .where(and(eq(staff.societyId, societyId), movedOrOpen(staffAttendance.enteredAt, staffAttendance.exitedAt)))
      .orderBy(desc(staffAttendance.enteredAt)),
  ])

  const served = await flatsServedBy(staffRows.map((row) => row.staff.id))
  const within = (value: Date | null) => value !== null && value >= from && value < to
  const people = [
    ...visitorRows.map((row) => {
      const visit = serializeVisit(row)
      return {
        id: visit.id,
        kind: 'VISITOR' as const,
        name: visit.visitorName,
        type: visit.purpose,
        flat: visit.flat.label,
        gateName: visit.gateName,
        vehicleNumber: visit.vehicleNumber,
        enteredAt: visit.enteredAt,
        exitedAt: visit.exitedAt,
        turnedAway: (visit.status === 'DENIED' || visit.status === 'LEAVE_AT_GATE') && within(visit.decidedAt),
      }
    }),
    ...staffRows.map((row) => ({
      id: row.attendance.id,
      kind: 'STAFF' as const,
      name: row.staff.name,
      type: row.staff.kind,
      flat: served
        .filter((flat) => flat.staffId === row.staff.id)
        .map((flat) => `${flat.blockName}-${flat.number}`)
        .join(', '),
      gateName: row.gateName,
      vehicleNumber: null,
      enteredAt: row.attendance.enteredAt,
      exitedAt: row.attendance.exitedAt,
      turnedAway: false,
    })),
  ]

  const movements: Movement[] = []
  for (const person of people) {
    const { enteredAt, exitedAt, turnedAway: _away, ...rest } = person
    if (within(enteredAt)) movements.push({ ...rest, direction: 'IN', at: enteredAt! })
    if (within(exitedAt)) movements.push({ ...rest, direction: 'OUT', at: exitedAt! })
  }
  movements.sort((a, b) => b.at.getTime() - a.at.getTime())

  const entries = movements.filter((movement) => movement.direction === 'IN')
  const inside = people.filter((person) => person.enteredAt !== null && person.exitedAt === null)
  const closed = people.filter((person) => person.enteredAt !== null && within(person.exitedAt))
  const perHour = new Map<number, number>()
  for (const entry of entries) perHour.set(entry.at.getHours(), (perHour.get(entry.at.getHours()) ?? 0) + 1)
  const busiest = [...perHour.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
  const byType: Record<string, number> = {}
  for (const entry of entries) byType[entry.kind === 'STAFF' ? 'STAFF' : entry.type] = (byType[entry.kind === 'STAFF' ? 'STAFF' : entry.type] ?? 0) + 1

  return {
    on: isoDay(from),
    metrics: {
      entries: entries.length,
      exits: movements.length - entries.length,
      stillInside: inside.length,
      /** Entered before this day began and never recorded out: the shift handover's one job */
      openOvernight: inside.filter((person) => person.enteredAt! < from).length,
      turnedAway: people.filter((person) => person.turnedAway).length,
      /** Over the visits that ended today, so an open visit never drags the average down */
      averageStayMinutes: closed.length
        ? Math.round(closed.reduce((total, person) => total + (person.exitedAt!.getTime() - person.enteredAt!.getTime()), 0) / closed.length / 60000)
        : null,
      busiestHour: busiest ? { hour: busiest[0], entries: busiest[1] } : null,
      byType,
    },
    movements: movements.slice(0, 200),
  }
}

/** Users who are not residents still need a society; the guard's own society scopes every call. */
export async function societyIdFor(ctx: AuthContext) {
  if (ctx.societyId) return ctx.societyId
  const [row] = await db.select({ id: users.societyId }).from(users).where(eq(users.id, ctx.userId))
  if (!row?.id) throw new AppError(400, 'INVALID_STATE', 'Your account is not linked to a society yet')
  return row.id
}
