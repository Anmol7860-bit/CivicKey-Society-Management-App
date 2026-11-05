import { and, asc, count, eq, gte, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import {
  blocks,
  communityGroupMembers,
  communityGroups,
  flatResidents,
  flats,
  societies,
  users,
  type CommunityGroup,
} from '../../db/schema.js'
import { AppError, type ErrorCode } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { assertState, deny, permissionDenied, requireRecord, UUID } from '../access/scope.js'
import { recordAuditEvent, type AuditEventType, type DbExecutor } from '../audit/audit.service.js'
import type { AddMemberBody, ArchiveGroupBody, CreateGroupBody, ListGroupsQuery } from './community.schemas.js'

function audit(tx: DbExecutor, ctx: AuthContext, eventType: AuditEventType, metadata: Record<string, unknown>) {
  return recordAuditEvent(tx, { eventType, actorUserId: ctx.userId, metadata })
}

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

/** A verified assignment inside its dates: the same test the rest of the app makes of a resident. */
const liveAssignment = () =>
  and(
    eq(flatResidents.verificationStatus, 'VERIFIED'),
    lte(flatResidents.startDate, sql`current_date`),
    or(isNull(flatResidents.endDate), gte(flatResidents.endDate, sql`current_date`)),
  )!

const livePart = isNull(communityGroupMembers.removedAt)

async function loadSociety(ctx: AuthContext, id: string) {
  const [row] = UUID.test(id) ? await db.select({ id: societies.id }).from(societies).where(eq(societies.id, id)) : []
  await requireRecord(ctx, row && { societyId: row.id }, 'Society')
  return row!
}

/** 404 when missing, 403 CROSS_SOCIETY_ACCESS outside the caller's society. */
async function loadGroup(ctx: AuthContext, id: string) {
  const [row] = UUID.test(id) ? await db.select().from(communityGroups).where(eq(communityGroups.id, id)) : []
  return requireRecord(ctx, row, 'Group')
}

/** The office's own power over every group. requirePermission read these from the database. */
function managesGroups(ctx: AuthContext) {
  return ctx.permissions?.includes('GROUP_MANAGE') ?? false
}

/** The caller's live row in a group, which is where a leader's power to add members comes from. */
async function membership(groupId: string, userId: string) {
  const [row] = await db
    .select({ role: communityGroupMembers.role })
    .from(communityGroupMembers)
    .where(and(eq(communityGroupMembers.groupId, groupId), eq(communityGroupMembers.userId, userId), livePart))
  return row?.role
}

/** The residents a SOCIETY or BLOCK group takes from the flat register; a CUSTOM group has none. */
function registerMembers(group: Pick<CommunityGroup, 'societyId' | 'scope' | 'blockId'>, userId?: string) {
  const filters = [eq(blocks.societyId, group.societyId), liveAssignment()]
  if (group.scope === 'BLOCK') filters.push(eq(blocks.id, group.blockId!))
  if (userId) filters.push(eq(flatResidents.userId, userId))
  return db
    .selectDistinct({ userId: flatResidents.userId, name: users.name, phone: users.phone })
    .from(flatResidents)
    .innerJoin(flats, eq(flats.id, flatResidents.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(users, eq(users.id, flatResidents.userId))
    .where(and(...filters))
    .orderBy(asc(users.name))
}

/** Guards and staff are never in a group: only a live resident of this society can be. */
async function assertEligible(group: CommunityGroup, userId: string) {
  const [row] = await db
    .select({ id: flatResidents.id })
    .from(flatResidents)
    .innerJoin(flats, eq(flats.id, flatResidents.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .where(and(eq(flatResidents.userId, userId), eq(blocks.societyId, group.societyId), liveAssignment()))
    .limit(1)
  if (!row) throw new AppError(409, 'ASSIGNEE_NOT_ELIGIBLE', 'Only a resident of this society can be in a group')
}

/**
 * Who may change a group's membership: the office anywhere, a leader in their own group. A leader
 * never appoints another leader, so the office stays in charge of who runs a group.
 */
async function assertMayChangeMembers(ctx: AuthContext, group: CommunityGroup, role?: 'LEADER' | 'MEMBER') {
  const manage = managesGroups(ctx)
  if (manage) return { manage }
  if ((await membership(group.id, ctx.userId)) !== 'LEADER' || role === 'LEADER') {
    throw await deny(ctx.userId, permissionDenied(), { groupId: group.id, needed: role === 'LEADER' ? 'GROUP_MANAGE' : 'group leadership' })
  }
  return { manage }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/**
 * The society's groups. The office sees them all; a resident sees the ones they are in, which for
 * a block or society group means the flat register puts them there.
 */
export async function listGroups(ctx: AuthContext, societyId: string, query: ListGroupsQuery) {
  await loadSociety(ctx, societyId)
  const filters = [eq(communityGroups.societyId, societyId)]
  if (query.scope) filters.push(eq(communityGroups.scope, query.scope))
  if (!query.archived) filters.push(isNull(communityGroups.archivedAt))

  const rows = await db
    .select({ group: communityGroups, blockName: blocks.name })
    .from(communityGroups)
    .leftJoin(blocks, eq(blocks.id, communityGroups.blockId))
    .where(and(...filters))
    .orderBy(asc(communityGroups.scope), asc(communityGroups.name))

  // Three small reads instead of a count per group: the hand-picked rows, and the register once
  // for the whole society and once per block.
  const [picked, perBlock, [societyTotal], mine] = await Promise.all([
    db
      .select({ groupId: communityGroupMembers.groupId, members: count() })
      .from(communityGroupMembers)
      .innerJoin(communityGroups, eq(communityGroups.id, communityGroupMembers.groupId))
      .where(and(eq(communityGroups.societyId, societyId), eq(communityGroups.scope, 'CUSTOM'), livePart))
      .groupBy(communityGroupMembers.groupId),
    db
      .selectDistinctOn([blocks.id, flatResidents.userId], { blockId: blocks.id, userId: flatResidents.userId })
      .from(flatResidents)
      .innerJoin(flats, eq(flats.id, flatResidents.flatId))
      .innerJoin(blocks, eq(blocks.id, flats.blockId))
      .where(and(eq(blocks.societyId, societyId), liveAssignment())),
    db
      .select({ residents: sql<number>`count(distinct ${flatResidents.userId})::int` })
      .from(flatResidents)
      .innerJoin(flats, eq(flats.id, flatResidents.flatId))
      .innerJoin(blocks, eq(blocks.id, flats.blockId))
      .where(and(eq(blocks.societyId, societyId), liveAssignment())),
    db
      .select({ groupId: communityGroupMembers.groupId, role: communityGroupMembers.role })
      .from(communityGroupMembers)
      .where(and(eq(communityGroupMembers.userId, ctx.userId), livePart)),
  ])

  const pickedCount = new Map(picked.map((row) => [row.groupId, Number(row.members)]))
  const blockCount = perBlock.reduce((counts, row) => counts.set(row.blockId, (counts.get(row.blockId) ?? 0) + 1), new Map<string, number>())
  const myRole = new Map(mine.map((row) => [row.groupId, row.role]))
  const myBlocks = new Set(perBlock.filter((row) => row.userId === ctx.userId).map((row) => row.blockId))

  const manage = managesGroups(ctx)
  return rows
    .map(({ group, blockName }) => {
      const derived = group.scope !== 'CUSTOM'
      const inRegister = group.scope === 'SOCIETY' ? myBlocks.size > 0 : group.scope === 'BLOCK' ? myBlocks.has(group.blockId!) : false
      return {
        ...group,
        blockName,
        derived,
        members: group.scope === 'SOCIETY' ? (societyTotal?.residents ?? 0) : group.scope === 'BLOCK' ? (blockCount.get(group.blockId!) ?? 0) : (pickedCount.get(group.id) ?? 0),
        myRole: myRole.get(group.id) ?? (inRegister ? ('MEMBER' as const) : null),
        mine: myRole.has(group.id) || inRegister,
      }
    })
    .filter((group) => manage || group.mine)
}

export async function createGroup(ctx: AuthContext, societyId: string, body: CreateGroupBody) {
  await loadSociety(ctx, societyId)
  if (body.blockId) {
    const [block] = await db.select({ societyId: blocks.societyId }).from(blocks).where(eq(blocks.id, body.blockId))
    await requireRecord(ctx, block, 'Block')
  }

  return db.transaction(async (tx) => {
    const [group] = await unique(
      tx
        .insert(communityGroups)
        .values({ societyId, name: body.name, purpose: body.purpose, scope: body.scope, blockId: body.blockId, createdBy: ctx.userId })
        .returning(),
      [
        'ALREADY_EXISTS',
        body.scope === 'CUSTOM'
          ? 'A group of this name already exists in the society'
          : 'This block or society already has its own group',
      ],
    )
    await audit(tx, ctx, 'GROUP_CREATED', { groupId: group!.id, name: group!.name, scope: group!.scope, blockId: group!.blockId })
    return group!
  })
}

/** Archiving keeps the group and its messages; it only takes it out of use, with a reason. */
export async function archiveGroup(ctx: AuthContext, id: string, body: ArchiveGroupBody) {
  const group = await loadGroup(ctx, id)
  assertState(!group.archivedAt, 'This group is already archived')

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(communityGroups)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(communityGroups.id, id))
      .returning()
    await audit(tx, ctx, 'GROUP_ARCHIVED', { groupId: id, name: group.name, reason: body.reason })
    return updated!
  })
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/**
 * Who is in the group. A hand-picked group lists its rows; a block or society group lists the
 * register, with the leaders the office appointed marked as such.
 */
export async function listMembers(ctx: AuthContext, groupId: string) {
  const group = await loadGroup(ctx, groupId)
  const [manage, mine] = [managesGroups(ctx), await membership(groupId, ctx.userId)]
  const derived = group.scope !== 'CUSTOM'
  if (!manage && !mine && !(derived && (await registerMembers(group, ctx.userId)).length)) {
    throw await deny(ctx.userId, permissionDenied(), { groupId })
  }

  const rows = await db
    .select({ userId: communityGroupMembers.userId, name: users.name, phone: users.phone, role: communityGroupMembers.role, joinedAt: communityGroupMembers.joinedAt })
    .from(communityGroupMembers)
    .innerJoin(users, eq(users.id, communityGroupMembers.userId))
    .where(and(eq(communityGroupMembers.groupId, groupId), livePart))
    .orderBy(asc(users.name))
  if (!derived) return rows.map((row) => ({ ...row, derived: false }))

  // The register is the truth for a derived group: a leader who has moved out is no longer in it
  const leaders = new Set(rows.filter((row) => row.role === 'LEADER').map((row) => row.userId))
  return (await registerMembers(group)).map((member) => ({
    ...member,
    role: leaders.has(member.userId) ? ('LEADER' as const) : ('MEMBER' as const),
    joinedAt: rows.find((row) => row.userId === member.userId)?.joinedAt ?? null,
    derived: !leaders.has(member.userId),
  }))
}

/**
 * Adds a member, or appoints a leader. A derived group's membership comes from the register, so
 * the only row worth writing on one is a leader's.
 */
export async function addMember(ctx: AuthContext, groupId: string, body: AddMemberBody) {
  const group = await loadGroup(ctx, groupId)
  assertState(!group.archivedAt, 'This group is archived')
  await assertMayChangeMembers(ctx, group, body.role)
  await assertEligible(group, body.userId)
  if (group.scope !== 'CUSTOM' && body.role === 'MEMBER') {
    assertState(false, 'Everyone the register puts in this group is already a member; only a leader is appointed here')
  }

  const existing = await membership(groupId, body.userId)
  return db.transaction(async (tx) => {
    if (existing === body.role) throw new AppError(409, 'ALREADY_EXISTS', 'That resident is already in the group')
    const row = existing
      ? await tx
          .update(communityGroupMembers)
          .set({ role: body.role })
          .where(and(eq(communityGroupMembers.groupId, groupId), eq(communityGroupMembers.userId, body.userId), livePart))
          .returning()
      : await unique(
          tx.insert(communityGroupMembers).values({ groupId, userId: body.userId, role: body.role, addedBy: ctx.userId }).returning(),
          ['ALREADY_EXISTS', 'That resident is already in the group'],
        )
    await audit(tx, ctx, 'GROUP_MEMBER_ADDED', { groupId, userId: body.userId, role: body.role, wasAMember: Boolean(existing) })
    return row[0]!
  })
}

/** Removes a member, keeping the row as history. Only the office removes a leader. */
export async function removeMember(ctx: AuthContext, groupId: string, userId: string) {
  const group = await loadGroup(ctx, groupId)
  const role = await membership(groupId, userId)
  if (!role) throw new AppError(404, 'NOT_FOUND', 'That resident is not in the group')
  await assertMayChangeMembers(ctx, group, role)

  return db.transaction(async (tx) => {
    await tx
      .update(communityGroupMembers)
      .set({ removedAt: new Date() })
      .where(and(eq(communityGroupMembers.groupId, groupId), eq(communityGroupMembers.userId, userId), livePart))
    await audit(tx, ctx, 'GROUP_MEMBER_REMOVED', { groupId, userId, role })
    return { groupId, userId, role }
  })
}
