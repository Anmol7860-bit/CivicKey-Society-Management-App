import { and, eq, gte, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { flatResidents, flats } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { recordAuditEvent } from '../audit/audit.service.js'
import type { Permission } from './permissions.js'

export const permissionDenied = () => new AppError(403, 'PERMISSION_DENIED', 'You are not authorized to perform this action.')
const crossSociety = () => new AppError(403, 'CROSS_SOCIETY_ACCESS', 'This resource belongs to another society')
const notYourFlat = () => new AppError(403, 'NOT_YOUR_FLAT', 'You do not have access to this flat')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Records the denial in the audit log and returns the error to throw. */
export async function deny(userId: string | null, error: AppError, metadata: Record<string, unknown> = {}) {
  await recordAuditEvent(db, { eventType: 'AUTHORIZATION_DENIED', actorUserId: userId, metadata: { code: error.code, ...metadata } })
  return error
}

/** Reads the permissions requirePermission loaded from the database; never anything the client sent. */
function permissionsOf(ctx: AuthContext) {
  if (!ctx.permissions) throw new Error('requirePermission must run before scope checks')
  return ctx.permissions
}

/** For any society-owned resource. ctx.societyId comes from the database (set by requirePermission). */
export async function assertSameSociety(ctx: AuthContext, resourceSocietyId: string) {
  permissionsOf(ctx)
  if (!ctx.societyId || ctx.societyId !== resourceSocietyId) {
    throw await deny(ctx.userId, crossSociety(), { resourceSocietyId })
  }
}

/**
 * State validation, steps 1-4: the loaded record, or 404 when missing and 403 CROSS_SOCIETY_ACCESS
 * when it belongs to another society.
 */
export async function requireRecord<T extends { societyId: string }>(ctx: AuthContext, record: T | undefined, name: string) {
  if (!record) throw new AppError(404, 'NOT_FOUND', `${name} not found`)
  await assertSameSociety(ctx, record.societyId)
  return record
}

/**
 * State validation, steps 5-6. Authorization alone does not make an operation valid, e.g.
 * assertState(bill.status === 'UNPAID', 'This bill is already paid').
 */
export function assertState(allowed: boolean, message: string) {
  if (!allowed) throw new AppError(400, 'INVALID_STATE', message)
}

export interface FlatAccessOptions {
  /** The operation changes data, so VIEW_ONLY residents are refused */
  write?: boolean
  /**
   * Lets a user act on any flat in their society when they hold this permission, e.g.
   * INVOICE_GENERATE for billing. Without it only the flat's own active Residents get through,
   * so committee membership never bypasses flat ownership by itself.
   */
  scopePermission?: Permission
}

export async function assertFlatAccess(ctx: AuthContext, flatId: string, { write = false, scopePermission }: FlatAccessOptions = {}) {
  const permissions = permissionsOf(ctx)
  const [flat] = UUID.test(flatId) ? await db.select({ societyId: flats.societyId }).from(flats).where(eq(flats.id, flatId)) : []
  await requireRecord(ctx, flat, 'Flat')

  if (scopePermission && permissions.includes(scopePermission)) return
  if (ctx.role !== 'RESIDENT') throw await deny(ctx.userId, permissionDenied(), { flatId })

  const links = await db
    .select({ accessLevel: flatResidents.accessLevel })
    .from(flatResidents)
    .where(
      and(
        eq(flatResidents.userId, ctx.userId),
        eq(flatResidents.flatId, flatId),
        lte(flatResidents.startDate, sql`current_date`),
        or(isNull(flatResidents.endDate), gte(flatResidents.endDate, sql`current_date`)),
      ),
    )
  if (links.length === 0) throw await deny(ctx.userId, notYourFlat(), { flatId })
  if (write && !links.some((link) => link.accessLevel === 'FULL')) throw await deny(ctx.userId, permissionDenied(), { flatId, write })
}
