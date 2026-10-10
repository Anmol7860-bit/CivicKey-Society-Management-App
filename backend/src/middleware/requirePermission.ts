import type { RequestHandler } from 'express'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { AppError } from '../lib/errors.js'
import { loadPermissions, type Permission } from '../modules/access/permissions.js'

const forbidden = () => new AppError(403, 'FORBIDDEN', 'You do not have permission for this action')

/**
 * Use after requireAuth. Reads the role and permissions from the database, not the token, so a
 * removed permission or a role change takes effect on the next request.
 */
export function requirePermission(permission: Permission): RequestHandler {
  return async (req, _res, next) => {
    const ctx = req.ctx
    if (!ctx) return next(new AppError(401, 'TOKEN_MISSING', 'Authentication required'))

    const [user] = await db
      .select({ role: users.role, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, ctx.userId))
    if (!user?.isActive) return next(forbidden())

    const permissions = await loadPermissions(db, ctx.userId, user.role)
    if (!permissions.includes(permission)) return next(forbidden())

    req.ctx = { ...ctx, role: user.role, permissions }
    next()
  }
}
