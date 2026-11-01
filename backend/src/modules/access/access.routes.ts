import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody } from '../../middleware/validateBody.js'
import * as service from './admin.service.js'
import { ADMIN_PERMISSIONS, COMMITTEE_PERMISSIONS } from './permissions.js'

const mobile = z.string().trim().regex(/^[6-9]\d{9}$/, 'Phone must be a 10-digit Indian mobile number')

const createAdminSchema = z.strictObject({
  name: z.string().trim().min(2, 'Name is required').max(120),
  phone: mobile,
  email: z.email('Email must be a valid email address').trim().toLowerCase().max(254).optional(),
  /** What this Admin may do. Only assignable permissions; a role grant is never set by hand. */
  permissions: z.array(z.enum(ADMIN_PERMISSIONS)).min(1, 'Choose at least one permission'),
})

const committeeSchema = z.strictObject({
  permissions: z.array(z.enum(COMMITTEE_PERMISSIONS)).min(1, 'Choose at least one permission'),
})

/** Admin accounts and committee permissions. Mounted at /api/v1. */
export function createAccessRouter() {
  const router = Router()
  const manage = [requireAuth, requirePermission('USER_MANAGE')]

  router.get('/societies/:societyId/admins', ...manage, async (req, res) => {
    res.json({ data: await service.listAdmins(req.ctx!, req.params.societyId as string) })
  })
  router.post('/societies/:societyId/admins', ...manage, validateBody(createAdminSchema), async (req, res) => {
    // The one-time code is in the body, so no cache may keep it
    res.setHeader('Cache-Control', 'no-store')
    res.status(201).json({ data: await service.createAdminAccount(req.ctx!, req.params.societyId as string, req.body) })
  })

  /** Committee access for a resident: the five billing and reporting permissions, never more. */
  router.post('/users/:userId/committee-permissions', ...manage, validateBody(committeeSchema), async (req, res) => {
    res.json({ data: await service.assignCommittee(req.ctx!, req.params.userId as string, req.body.permissions) })
  })
  router.delete('/users/:userId/committee-permissions', ...manage, async (req, res) => {
    res.json({ data: await service.endCommittee(req.ctx!, req.params.userId as string) })
  })

  return router
}
