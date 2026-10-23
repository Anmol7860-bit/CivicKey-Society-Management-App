import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { parseOrThrow, validateBody } from '../../middleware/validateBody.js'
import { issueSetupCode } from '../auth/passwordSetup.js'
import {
  listResidentsSchema,
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

  /** The signed-in person's own assignments; no management permission, and only their own rows */
  router.get('/me/flats', requireAuth, async (req, res) => {
    res.json({ data: await service.listMyAssignments(req.ctx!) })
  })

  router.get('/flats/:flatId/residents', ...manage, async (req, res) => {
    res.json({ data: await service.listFlatResidents(req.ctx!, req.params.flatId as string) })
  })
  router.post('/flats/:flatId/residents', ...manage, validateBody(registerResidentSchema), async (req, res) => {
    res.status(201).json({ data: await service.registerResident(req.ctx!, req.params.flatId as string, req.body) })
  })

  /** A one-time code the office hands over so the person can set their own password. */
  router.post('/users/:userId/login-code', ...manage, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ data: await issueSetupCode(req.ctx!, req.params.userId as string) })
  })

  // ?status=PENDING is the approval queue; ?active=true who holds access today
  router.get('/societies/:societyId/residents', ...manage, async (req, res) => {
    const query = parseOrThrow(listResidentsSchema, req.query)
    res.json({ data: await service.listResidents(req.ctx!, req.params.societyId as string, query) })
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
