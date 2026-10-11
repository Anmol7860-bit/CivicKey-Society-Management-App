import type { RequestHandler } from 'express'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { AppError } from '../lib/errors.js'
import { loadPermissions, type Permission } from '../modules/access/permissions.js'
import { deny, permissionDenied } from '../modules/access/scope.js'

/**
 * Use after requireAuth. Reads the role, society and permissions from the database, not the token
 * or the request, so a removed permission or a role change takes effect on the next request.
 */
export function requirePermission(permission: Permission): RequestHandler {
  return async (req, _res, next) => {
    const ctx = req.ctx
    if (!ctx) return next(new AppError(401, 'TOKEN_MISSING', 'Authentication required'))

    const [user] = await db
      .select({ role: users.role, isActive: users.isActive, societyId: users.societyId })
      .from(users)
      .where(eq(users.id, ctx.userId))
    const permissions = user?.isActive ? await loadPermissions(db, ctx.userId, user.role) : []
    if (!permissions.includes(permission)) {
      return next(await deny(user ? ctx.userId : null, permissionDenied(), { permission, method: req.method, path: req.originalUrl }))
    }

    req.ctx = { ...ctx, role: user!.role, societyId: user!.societyId, permissions }
    next()
  }
}
