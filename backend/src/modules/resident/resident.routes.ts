import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody } from '../../middleware/validateBody.js'
import {
  registerResidentSchema,
  rejectResidentSchema,
  updateResidentSchema,
  verifyResidentSchema,
} from './resident.schemas.js'
import * as service from './resident.service.js'

/** Resident and tenant assignments: register, verify, extend and close. Mounted at /api/v1. */
export function createResidentRouter() {
  const router = Router()
  const manage = [requireAuth, requirePermission('USER_MANAGE')]

  router.get('/flats/:flatId/residents', ...manage, async (req, res) => {
    res.json({ data: await service.listFlatResidents(req.ctx!, req.params.flatId as string) })
  })
  router.post('/flats/:flatId/residents', ...manage, validateBody(registerResidentSchema), async (req, res) => {
    res.status(201).json({ data: await service.registerResident(req.ctx!, req.params.flatId as string, req.body) })
  })

  router.get('/societies/:societyId/residents/pending', ...manage, async (req, res) => {
    res.json({ data: await service.listPendingResidents(req.ctx!, req.params.societyId as string) })
  })

  router.post('/residents/:id/verify', ...manage, validateBody(verifyResidentSchema), async (req, res) => {
    res.json({ data: await service.verifyResident(req.ctx!, req.params.id as string, req.body) })
  })
  router.post('/residents/:id/reject', ...manage, validateBody(rejectResidentSchema), async (req, res) => {
    res.json({ data: await service.rejectResident(req.ctx!, req.params.id as string, req.body) })
  })
  router.put('/residents/:id', ...manage, validateBody(updateResidentSchema), async (req, res) => {
    res.json({ data: await service.updateResident(req.ctx!, req.params.id as string, req.body) })
  })

  return router
}
