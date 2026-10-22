import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { parseOrThrow, validateBody } from '../../middleware/validateBody.js'
import { createStaffSchema, listStaffSchema, updateStaffSchema } from './staff.schemas.js'
import * as service from './staff.service.js'

/**
 * Guards, daily help and vendors. A guard needs GUARD_MANAGE and everyone else STAFF_MANAGE;
 * the route lets either through and the service enforces the one that fits the record's kind.
 */
export function createStaffRouter() {
  const router = Router()
  const manage = [requireAuth, requirePermission('GUARD_MANAGE', 'STAFF_MANAGE')]

  router.get('/societies/:societyId/staff', ...manage, async (req, res) => {
    const query = parseOrThrow(listStaffSchema, req.query)
    res.json({
      data: await service.listStaff(req.ctx!, req.params.societyId as string, query),
    })
  })
  router.post('/societies/:societyId/staff', ...manage, validateBody(createStaffSchema), async (req, res) => {
    res.status(201).json({
      data: await service.createStaff(req.ctx!, req.params.societyId as string, req.body),
    })
  })
  router.put('/staff/:id', ...manage, validateBody(updateStaffSchema), async (req, res) => {
    res.json({
      data: await service.updateStaff(req.ctx!, req.params.id as string, req.body),
    })
  })
  router.post('/staff/:id/pass', ...manage, async (req, res) => {
    res.json({
      data: await service.reissuePass(req.ctx!, req.params.id as string),
    })
  })

  return router
}
