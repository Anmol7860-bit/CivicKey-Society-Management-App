import type { RequestHandler } from 'express'
import { assertFlatAccess, type FlatAccessOptions } from '../modules/access/scope.js'

/**
 * Use after requirePermission on routes with a :flatId param. Operations that take the flatId from
 * the body call assertFlatAccess themselves with the value they act on.
 */
export function requireFlatAccess(options: FlatAccessOptions = {}): RequestHandler {
  return async (req, _res, next) => {
    await assertFlatAccess(req.ctx!, String(req.params.flatId), options)
    next()
  }
}
