import { and, eq, gte, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { flatResidents, permissions, rolePermissions, roles, userPermissions, userRoles, users, type Role } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import { recordAuditEvent, type DbExecutor } from '../audit/audit.service.js'

// The permissions table is the source of truth; these lists mirror the master data inserted by
// migration 0006 so code can name permissions with type checking. A test keeps them in step.

export const GENERAL_ADMIN_PERMISSIONS = ['SOCIETY_MANAGE', 'USER_MANAGE', 'GUARD_MANAGE', 'STAFF_MANAGE', 'AUDIT_VIEW'] as const

export const COMMITTEE_PERMISSIONS = ['BILLING_RATE_SET', 'INVOICE_GENERATE', 'PAYMENT_CASH_MARK', 'REPORT_VIEW'] as const

/** Only these can be assigned to a user; Guard and Resident permissions come from the role. */
export const ADMIN_PERMISSIONS = [...GENERAL_ADMIN_PERMISSIONS, ...COMMITTEE_PERMISSIONS] as const

/** role_permissions for GUARD */
export const GUARD_PERMISSIONS = [
  'VISIT_REGISTER',
  /** The Guard's gate decision; separate from the Resident's VISITOR_APPROVE */
  'VISIT_DECIDE',
  'VISIT_ENTRY_RECORD',
  'VISIT_EXIT',
  'PASS_VALIDATE',
] as const

/** role_permissions for RESIDENT */
export const RESIDENT_PERMISSIONS = [
  /** The Resident's approval of a visitor to their own flat */
  'VISITOR_APPROVE',
  'VISITOR_PASS_CREATE',
  'VISIT_VIEW_OWN',
  'BILL_VIEW_OWN',
  'BILL_PAY',
  'RECEIPT_VIEW_OWN',
] as const

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number]
export type Permission = AdminPermission | (typeof GUARD_PERMISSIONS)[number] | (typeof RESIDENT_PERMISSIONS)[number]

/** The user's role from user_roles, or undefined when none is assigned. */
export async function loadRole(executor: DbExecutor, userId: string) {
  const [row] = await executor
    .select({ role: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId))
  return row?.role
}

/** Sets the user's single role, replacing any previous one. */
export async function assignRole(executor: DbExecutor, userId: string, role: Role) {
  const roleId = sql`(select ${roles.id} from ${roles} where ${roles.name} = ${role})`
  await executor
    .insert(userRoles)
    .values({ userId, roleId })
    .onConflictDoUpdate({ target: userRoles.userId, set: { roleId } })
}

/**
 * Effective permissions: the role's permissions plus, for Admins, their active user-specific
 * Admin permissions. So a committee member never gains General Admin permissions by holding the
 * ADMIN role, and permissions stored for a Guard or Resident are ignored.
 */
export async function loadPermissions(executor: DbExecutor, userId: string, role: Role): Promise<Permission[]> {
  // A Resident put on the committee keeps their resident functions: the ADMIN role is added to
  // their flat, it never replaces it. A verified flat assignment is the only thing that says so,
  // so a staff Admin or Guard with no assignment gains nothing here.
  const fromRoles: Role[] = role !== 'RESIDENT' && (await isResident(executor, userId)) ? [role, 'RESIDENT'] : [role]
  const fromRole = await executor
    .select({ code: permissions.code })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
    .where(inArray(roles.name, fromRoles))
  const assigned =
    role === 'ADMIN'
      ? await executor
          .select({ code: permissions.code })
          .from(userPermissions)
          .innerJoin(permissions, eq(permissions.id, userPermissions.permissionId))
          .where(
            and(
              eq(userPermissions.userId, userId),
              isNull(userPermissions.revokedAt),
              inArray(permissions.code, [...ADMIN_PERMISSIONS]),
            ),
          )
      : []
  const codes = new Set([...fromRole, ...assigned].map((row) => row.code))
  return ([...codes] as Permission[]).sort()
}

/**
 * Whether the user is a Resident: someone with a verified, currently valid flat assignment.
 * A verified mobile number or an account alone is never enough.
 */
export async function isResident(executor: DbExecutor, userId: string) {
  const [row] = await executor
    .select({ id: flatResidents.id })
    .from(flatResidents)
    .where(
      and(
        eq(flatResidents.userId, userId),
        eq(flatResidents.verificationStatus, 'VERIFIED'),
        lte(flatResidents.startDate, sql`current_date`),
        or(isNull(flatResidents.endDate), gte(flatResidents.endDate, sql`current_date`)),
      ),
    )
    .limit(1)
  return row !== undefined
}

/** GET /auth/permissions: the role and permissions as stored now, not as the token claims them. */
export async function getEffectivePermissions(userId: string) {
  const [user] = await db
    .select({ isActive: users.isActive, role: roles.name })
    .from(users)
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .leftJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(users.id, userId))
  // A deactivated user has no active role
  if (!user?.isActive || !user.role) throw new AppError(403, 'ROLE_NOT_ASSIGNED', 'No active role is assigned to this user')

  return {
    userId,
    role: user.role,
    permissions: await loadPermissions(db, userId, user.role),
  }
}

// ---------------------------------------------------------------------------
// Committee membership
// ---------------------------------------------------------------------------

const committeeError = (message: string) => new AppError(409, 'COMMITTEE_NOT_ALLOWED', message)

async function permissionIds(executor: DbExecutor, codes: readonly Permission[]) {
  const rows = await executor.select({ id: permissions.id }).from(permissions).where(inArray(permissions.code, [...codes]))
  return rows.map((row) => row.id)
}

/** Revokes the user's active grants among `ids`; revoked rows stay as history. */
function revokeGrants(executor: DbExecutor, userId: string, ids: string[]) {
  return executor
    .update(userPermissions)
    .set({ revokedAt: new Date() })
    .where(and(eq(userPermissions.userId, userId), inArray(userPermissions.permissionId, ids), isNull(userPermissions.revokedAt)))
}

/**
 * Makes a Resident a committee member with exactly the given committee permissions. Their role
 * becomes ADMIN; their flat assignments are untouched. Calling it again replaces the committee permissions.
 */
export async function setCommitteeMembership(
  actorUserId: string,
  userId: string,
  granted: readonly (typeof COMMITTEE_PERMISSIONS)[number][],
) {
  if (granted.length === 0) throw committeeError('Assign at least one committee permission')
  if (granted.some((permission) => !(COMMITTEE_PERMISSIONS as readonly string[]).includes(permission))) {
    throw committeeError('Only committee permissions can be assigned this way')
  }

  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update')
    // A verified flat assignment is what makes someone a Resident; a staff Admin has none
    if (!user || !(await isResident(tx, userId))) throw committeeError('Only Residents can be committee members')

    const keep = await permissionIds(tx, granted)
    const committee = await permissionIds(tx, COMMITTEE_PERMISSIONS)
    await revokeGrants(tx, userId, committee.filter((id) => !keep.includes(id)))
    const now = new Date()
    await tx
      .insert(userPermissions)
      .values(keep.map((permissionId) => ({ userId, permissionId, grantedBy: actorUserId, grantedAt: now })))
      .onConflictDoUpdate({
        target: [userPermissions.userId, userPermissions.permissionId],
        set: { grantedBy: actorUserId, grantedAt: now, revokedAt: null },
        // An already active grant keeps its original granter and time
        setWhere: sql`${userPermissions.revokedAt} is not null`,
      })
    await assignRole(tx, userId, 'ADMIN')
    await tx.update(users).set({ updatedAt: now }).where(eq(users.id, userId))
    await recordAuditEvent(tx, {
      eventType: 'COMMITTEE_MEMBERSHIP_SET',
      actorUserId,
      metadata: { userId, permissions: [...granted] },
    })
  })
}

/**
 * Revokes the committee permissions. A Resident left with no other active Admin permission goes
 * back to the RESIDENT role; their flat assignments are untouched.
 */
export async function removeCommitteeMembership(actorUserId: string, userId: string) {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update')
    if (!user) throw committeeError('User not found')

    const committee = await permissionIds(tx, COMMITTEE_PERMISSIONS)
    await revokeGrants(tx, userId, committee)
    const remaining = await tx
      .select({ id: userPermissions.permissionId })
      .from(userPermissions)
      .where(and(eq(userPermissions.userId, userId), isNull(userPermissions.revokedAt), notInArray(userPermissions.permissionId, committee)))
    if (remaining.length === 0 && (await isResident(tx, userId))) {
      await assignRole(tx, userId, 'RESIDENT')
      await tx.update(users).set({ updatedAt: new Date() }).where(eq(users.id, userId))
    }
    await recordAuditEvent(tx, { eventType: 'COMMITTEE_MEMBERSHIP_REMOVED', actorUserId, metadata: { userId } })
  })
}
