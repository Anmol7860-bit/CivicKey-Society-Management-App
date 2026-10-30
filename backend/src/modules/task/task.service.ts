import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { auditLogs, communityTasks, societies, staff, users } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { requireRecord, UUID } from '../access/scope.js'
import { recordAuditEvent, type AuditEventType, type DbExecutor } from '../audit/audit.service.js'
import type { CreateTaskBody, ListTasksQuery, TaskStatusBody, UpdateTaskBody } from './task.schemas.js'

const CLOSED = ['DONE', 'CANCELLED'] as const

function audit(tx: DbExecutor, ctx: AuthContext, eventType: AuditEventType, metadata: Record<string, unknown>) {
  return recordAuditEvent(tx, { eventType, actorUserId: ctx.userId, metadata })
}

async function loadSociety(executor: DbExecutor, ctx: AuthContext, id: string) {
  const [row] = UUID.test(id) ? await executor.select({ id: societies.id }).from(societies).where(eq(societies.id, id)) : []
  await requireRecord(ctx, row && { societyId: row.id }, 'Society')
  return row!
}

/** 404 when missing, 403 CROSS_SOCIETY_ACCESS outside the Admin's society. */
async function loadTask(executor: DbExecutor, ctx: AuthContext, id: string, lock?: 'update') {
  let query = executor.select().from(communityTasks).where(eq(communityTasks.id, id)).$dynamic()
  if (lock) query = query.for(lock)
  const [row] = UUID.test(id) ? await query : []
  return requireRecord(ctx, row, 'Task')
}

/** A task may only be handed to staff already registered with this society. */
async function assertStaffInSociety(tx: DbExecutor, societyId: string, staffId: string | null | undefined) {
  if (!staffId) return
  const [row] = await tx
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.societyId, societyId), eq(staff.status, 'ACTIVE')))
  if (!row) throw new AppError(409, 'ASSIGNEE_NOT_ELIGIBLE', 'That person is not active staff in this society')
}

const assignee = { id: staff.id, name: staff.name, kind: staff.kind, phone: staff.phone, workType: staff.workType }

function withAssignee(executor: DbExecutor) {
  return executor
    .select({
      task: communityTasks,
      assignee: assignee,
      raisedByName: users.name,
      overdue: sql<boolean>`${communityTasks.dueDate} is not null and ${communityTasks.dueDate} < current_date and ${communityTasks.status} not in ('DONE', 'CANCELLED')`,
    })
    .from(communityTasks)
    .leftJoin(staff, eq(staff.id, communityTasks.assignedStaffId))
    .leftJoin(users, eq(users.id, communityTasks.raisedBy))
}

type Row = { task: typeof communityTasks.$inferSelect; assignee: typeof assignee | null; raisedByName: string | null; overdue: boolean }

const shape = (row: Row) => ({ ...row.task, assignee: row.assignee, raisedByName: row.raisedByName, overdue: row.overdue })

/**
 * The society's work list. Open work first, then the most pressing, then the oldest: what the
 * office should pick up next is always at the top.
 */
export async function listTasks(ctx: AuthContext, societyId: string, query: ListTasksQuery) {
  await loadSociety(db, ctx, societyId)
  const filters = [eq(communityTasks.societyId, societyId)]
  if (query.status) filters.push(eq(communityTasks.status, query.status))
  if (query.category) filters.push(eq(communityTasks.category, query.category))
  if (query.assignedStaffId) filters.push(eq(communityTasks.assignedStaffId, query.assignedStaffId))
  if (query.overdue) {
    filters.push(isNotNull(communityTasks.dueDate), lt(communityTasks.dueDate, sql`current_date`), sql`${communityTasks.status} not in ('DONE', 'CANCELLED')`)
  }
  if (query.from) filters.push(gte(communityTasks.createdAt, new Date(`${query.from}T00:00:00.000Z`)))
  if (query.to) filters.push(lte(communityTasks.createdAt, new Date(`${query.to}T23:59:59.999Z`)))
  if (query.search) {
    const pattern = `%${query.search}%`
    filters.push(
      or(ilike(communityTasks.title, pattern), ilike(communityTasks.details, pattern), ilike(communityTasks.location, pattern))!,
    )
  }

  const rows = await withAssignee(db)
    .where(and(...filters))
    .orderBy(
      sql`case ${communityTasks.status} when 'OPEN' then 0 when 'IN_PROGRESS' then 1 else 2 end`,
      sql`case ${communityTasks.priority} when 'HIGH' then 0 when 'NORMAL' then 1 else 2 end`,
      sql`${communityTasks.dueDate} asc nulls last`,
      desc(communityTasks.createdAt),
    )
    .limit(query.limit)
    .offset((query.page - 1) * query.limit)
  return rows.map((row) => shape(row as Row))
}

/** One task, with everything the detail panel shows. */
export async function getTask(ctx: AuthContext, id: string) {
  await loadTask(db, ctx, id)
  const [row] = await withAssignee(db).where(eq(communityTasks.id, id))
  return shape(row as Row)
}

/**
 * What has happened to a task, oldest first: raised, edited, reassigned, moved and closed.
 *
 * The audit log is the history. It is written in the same transaction as every change, is never
 * updated or deleted, and already carries the actor and the server's own timestamp, so a second
 * history table would only be a copy that could disagree with it.
 */
export async function taskHistory(ctx: AuthContext, id: string) {
  const task = await loadTask(db, ctx, id)
  const rows = await db
    .select({ event: auditLogs, actorName: users.name })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    // ponytail: filtered on the metadata, which has no index; add one if a society's audit log
    // ever grows big enough for this to be slow.
    .where(
      and(
        inArray(auditLogs.eventType, ['TASK_CREATED', 'TASK_UPDATED', 'TASK_STATUS_CHANGED']),
        sql`${auditLogs.metadata} ->> 'taskId' = ${task.id}`,
      ),
    )
    .orderBy(asc(auditLogs.createdAt))

  return rows.map(({ event, actorName }) => {
    const { taskId: _taskId, societyId: _societyId, ...detail } = event.metadata
    return {
      id: event.id,
      eventType: event.eventType,
      actorName,
      at: event.createdAt,
      detail,
    }
  })
}

/** Counts for the summary tiles, so the page does not add up a truncated list. */
export async function taskSummary(ctx: AuthContext, societyId: string) {
  await loadSociety(db, ctx, societyId)
  const [row] = await db
    .select({
      open: sql<number>`count(*) filter (where ${communityTasks.status} = 'OPEN')::int`,
      inProgress: sql<number>`count(*) filter (where ${communityTasks.status} = 'IN_PROGRESS')::int`,
      overdue: sql<number>`count(*) filter (where ${communityTasks.status} not in ('DONE', 'CANCELLED') and ${communityTasks.dueDate} < current_date)::int`,
      unassigned: sql<number>`count(*) filter (where ${communityTasks.status} not in ('DONE', 'CANCELLED') and ${communityTasks.assignedStaffId} is null)::int`,
      doneThisMonth: sql<number>`count(*) filter (where ${communityTasks.status} = 'DONE' and ${communityTasks.closedAt} >= date_trunc('month', current_date))::int`,
    })
    .from(communityTasks)
    .where(eq(communityTasks.societyId, societyId))
  return row!
}

export function createTask(ctx: AuthContext, societyId: string, body: CreateTaskBody) {
  return db.transaction(async (tx) => {
    await loadSociety(tx, ctx, societyId)
    await assertStaffInSociety(tx, societyId, body.assignedStaffId)
    const [created] = await tx
      .insert(communityTasks)
      .values({
        societyId,
        title: body.title,
        details: body.details ?? null,
        location: body.location ?? null,
        dueDate: body.dueDate ?? null,
        assignedStaffId: body.assignedStaffId ?? null,
        raisedBy: ctx.userId,
        ...(body.category ? { category: body.category } : {}),
        ...(body.priority ? { priority: body.priority } : {}),
      })
      .returning()
    await audit(tx, ctx, 'TASK_CREATED', { societyId, taskId: created!.id, title: created!.title, category: created!.category })
    const [row] = await withAssignee(tx).where(eq(communityTasks.id, created!.id))
    return shape(row as Row)
  })
}

export function updateTask(ctx: AuthContext, id: string, body: UpdateTaskBody) {
  return db.transaction(async (tx) => {
    const task = await loadTask(tx, ctx, id, 'update')
    if (CLOSED.includes(task.status as (typeof CLOSED)[number])) {
      throw new AppError(409, 'INVALID_STATE', 'This task is closed, so it cannot be edited')
    }
    await assertStaffInSociety(tx, task.societyId, body.assignedStaffId)
    await tx
      .update(communityTasks)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(communityTasks.id, id))
    // Who the work moved from and to, not just that it moved: the history is read from these rows
    const reassigned = 'assignedStaffId' in body && (body.assignedStaffId ?? null) !== task.assignedStaffId
    await audit(tx, ctx, 'TASK_UPDATED', {
      societyId: task.societyId,
      taskId: id,
      fields: Object.keys(body),
      ...(reassigned ? { assignedFrom: task.assignedStaffId, assignedTo: body.assignedStaffId ?? null } : {}),
    })
    const [row] = await withAssignee(tx).where(eq(communityTasks.id, id))
    return shape(row as Row)
  })
}

/**
 * Moves a task along. Closing records when and why; reopening clears both, so a task never
 * claims to be finished and open at once.
 */
export function setTaskStatus(ctx: AuthContext, id: string, body: TaskStatusBody) {
  return db.transaction(async (tx) => {
    const task = await loadTask(tx, ctx, id, 'update')
    if (task.status === body.status) {
      throw new AppError(409, 'INVALID_STATE', `This task is already ${body.status.toLowerCase().replace('_', ' ')}`)
    }
    if (task.status === 'CANCELLED') {
      throw new AppError(409, 'INVALID_STATE', 'A cancelled task cannot be moved again')
    }
    const closing = CLOSED.includes(body.status as (typeof CLOSED)[number])
    await tx
      .update(communityTasks)
      .set({
        status: body.status,
        closedAt: closing ? new Date() : null,
        closingNote: closing ? (body.note ?? null) : null,
        updatedAt: new Date(),
      })
      .where(eq(communityTasks.id, id))
    await audit(tx, ctx, 'TASK_STATUS_CHANGED', {
      societyId: task.societyId,
      taskId: id,
      from: task.status,
      to: body.status,
      ...(body.note ? { note: body.note } : {}),
    })
    const [row] = await withAssignee(tx).where(eq(communityTasks.id, id))
    return shape(row as Row)
  })
}
