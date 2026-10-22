import type { RequestHandler } from 'express'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { roles, userRoles, users } from '../db/schema.js'
import { AppError } from '../lib/errors.js'
import { loadPermissions, type Permission } from '../modules/access/permissions.js'
import { deny, permissionDenied } from '../modules/access/scope.js'

/**
 * Use after requireAuth. Reads the role, society and permissions from the database, not the token
 * or the request, so a removed permission or a role change takes effect on the next request.
 * Given several permissions, any one of them lets the request through, and the handler decides
 * what each allows: Staff management takes either Manage guards or Register staff.
 */
export function requirePermission(...accepted: [Permission, ...Permission[]]): RequestHandler {
  return async (req, _res, next) => {
    const ctx = req.ctx
    if (!ctx) return next(new AppError(401, 'TOKEN_MISSING', 'Authentication required'))

    const [user] = await db
      .select({ role: roles.name, isActive: users.isActive, societyId: users.societyId })
      .from(users)
      .leftJoin(userRoles, eq(userRoles.userId, users.id))
      .leftJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(users.id, ctx.userId))
    const permissions = user?.isActive && user.role ? await loadPermissions(db, ctx.userId, user.role) : []
    if (!accepted.some((permission) => permissions.includes(permission))) {
      return next(
        await deny(user ? ctx.userId : null, permissionDenied(), {
          permission: accepted.join(' or '),
          method: req.method,
          path: req.originalUrl,
        }),
      )
    }

    req.ctx = { ...ctx, role: user!.role!, societyId: user!.societyId, permissions }
    next()
  }
}
