import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { adminPermission, userPermissions, users, type AdminPermission, type Role } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import { recordAuditEvent, type DbExecutor } from '../audit/audit.service.js'

export const GUARD_PERMISSIONS = [
  'VISITOR_REGISTER',
  /** The Guard's gate decision; separate from the Resident's VISITOR_APPROVE */
  'VISIT_DECIDE',
  'VISIT_ENTRY_RECORD',
  'VISIT_EXIT_RECORD',
  'PASS_VALIDATE',
] as const

export const RESIDENT_PERMISSIONS = [
  /** The Resident's approval of a visitor to their own flat */
  'VISITOR_APPROVE',
  'VISITOR_PASS_CREATE',
  'VISIT_VIEW_OWN',
  'BILL_VIEW_OWN',
  'BILL_PAY',
  'RECEIPT_VIEW_OWN',
] as const

export const COMMITTEE_PERMISSIONS = [
  'BILLING_RATE_SET',
  'INVOICE_GENERATE',
  'PAYMENT_CASH_MARK',
  'REPORT_VIEW',
] as const satisfies readonly AdminPermission[]

export type Permission = AdminPermission | (typeof GUARD_PERMISSIONS)[number] | (typeof RESIDENT_PERMISSIONS)[number]

/**
 * Guards and Residents get a fixed set from their role. Admins get only what is assigned to them,
 * so a committee member never gains General Admin permissions by holding the ADMIN role.
 * Assigned rows are ignored for other roles.
 */
export function effectivePermissions(role: Role, assigned: readonly AdminPermission[]): Permission[] {
  if (role === 'GUARD') return [...GUARD_PERMISSIONS]
  if (role === 'RESIDENT') return [...RESIDENT_PERMISSIONS]
  return adminPermission.enumValues.filter((permission) => assigned.includes(permission))
}

export async function loadPermissions(executor: DbExecutor, userId: string, role: Role) {
  const rows = await executor
    .select({ permission: userPermissions.permission })
    .from(userPermissions)
    .where(eq(userPermissions.userId, userId))
  return effectivePermissions(
    role,
    rows.map((row) => row.permission),
  )
}

/** GET /auth/permissions: the role and permissions as stored now, not as the token claims them. */
export async function getEffectivePermissions(userId: string) {
  const [user] = await db
    .select({ role: users.role, residentType: users.residentType, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
  // The role column is the user's single active role; a missing or deactivated user has none
  if (!user?.isActive) throw new AppError(403, 'ROLE_NOT_ASSIGNED', 'No active role is assigned to this user')

  return {
    userId,
    role: user.role,
    residentType: user.residentType,
    permissions: await loadPermissions(db, userId, user.role),
  }
}

// ---------------------------------------------------------------------------
// Committee membership
// ---------------------------------------------------------------------------

const committeeError = (message: string) => new AppError(409, 'COMMITTEE_NOT_ALLOWED', message)

/**
 * Makes a Resident a committee member with exactly the given committee permissions. Their role
 * becomes ADMIN; their Resident Type is kept. Calling it again replaces the committee permissions.
 */
export async function setCommitteeMembership(
  actorUserId: string,
  userId: string,
  permissions: readonly (typeof COMMITTEE_PERMISSIONS)[number][],
) {
  if (permissions.length === 0) throw committeeError('Assign at least one committee permission')
  if (permissions.some((permission) => !(COMMITTEE_PERMISSIONS as readonly string[]).includes(permission))) {
    throw committeeError('Only committee permissions can be assigned this way')
  }

  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update')
    // residentType marks Resident identity; an ADMIN without it is a staff admin, not a resident
    if (!user || !user.residentType) throw committeeError('Only Residents can be committee members')

    await tx
      .delete(userPermissions)
      .where(and(eq(userPermissions.userId, userId), inArray(userPermissions.permission, [...COMMITTEE_PERMISSIONS])))
    await tx.insert(userPermissions).values(permissions.map((permission) => ({ userId, permission, grantedBy: actorUserId })))
    await tx.update(users).set({ role: 'ADMIN', updatedAt: new Date() }).where(eq(users.id, userId))
    await recordAuditEvent(tx, {
      eventType: 'COMMITTEE_MEMBERSHIP_SET',
      actorUserId,
      metadata: { userId, permissions: [...permissions] },
    })
  })
}

/**
 * Removes the committee permissions. A Resident left with no other Admin permission goes back to
 * the RESIDENT role with their Resident Type unchanged.
 */
export async function removeCommitteeMembership(actorUserId: string, userId: string) {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update')
    if (!user) throw committeeError('User not found')

    await tx
      .delete(userPermissions)
      .where(and(eq(userPermissions.userId, userId), inArray(userPermissions.permission, [...COMMITTEE_PERMISSIONS])))
    const remaining = await tx.select().from(userPermissions).where(eq(userPermissions.userId, userId))
    if (user.residentType && remaining.length === 0) {
      await tx.update(users).set({ role: 'RESIDENT', updatedAt: new Date() }).where(eq(users.id, userId))
    }
    await recordAuditEvent(tx, { eventType: 'COMMITTEE_MEMBERSHIP_REMOVED', actorUserId, metadata: { userId } })
  })
}
