import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { parseOrThrow, validateBody } from '../../middleware/validateBody.js'
import * as flatService from '../flat/flat.service.js'
import {
  accessRequestSchema,
  addVehicleSchema,
  createPassSchema,
  decideAccessRequestSchema,
  decideVisitSchema,
  entryCodeSchema,
  gateLogSchema,
  listVisitsSchema,
  markLeaveSchema,
  recordEntrySchema,
  registerVisitAtGateSchema,
  staffMovementHistorySchema,
  staffMovementSchema,
  staffRejectionSchema,
  visitorLookupSchema,
} from './gate.schemas.js'
import * as service from './gate.service.js'

/**
 * The gate, from both sides: the guard registering and recording, and the resident approving,
 * issuing passes and watching their own flat. Each route carries the permission its screen needs.
 */
export function createGateRouter() {
  const router = Router()
  const register = [requireAuth, requirePermission('VISIT_REGISTER')]
  const validate = [requireAuth, requirePermission('PASS_VALIDATE')]
  const atGate = [requireAuth, requirePermission('VISIT_REGISTER', 'VISIT_ENTRY_RECORD', 'VISIT_EXIT', 'VISIT_DECIDE', 'PASS_VALIDATE')]
  const ownFlat = [requireAuth, requirePermission('VISIT_VIEW_OWN')]
  // The scope checks read the loaded permissions, so every route below names the ones it accepts
  const ownFlatOrOffice = [requireAuth, requirePermission('VISIT_VIEW_OWN', 'USER_MANAGE')]
  const ownFlatOrStaffOffice = [requireAuth, requirePermission('VISIT_VIEW_OWN', 'STAFF_MANAGE')]
  // The office audits staff movement; a guard reads back only the gate they are standing at
  const movementHistory = [requireAuth, requirePermission('STAFF_MANAGE', 'AUDIT_VIEW', 'PASS_VALIDATE')]

  // --- The guard's screens -------------------------------------------------
  router.get('/societies/:societyId/gate-summary', ...atGate, async (req, res) => {
    res.json({ data: await service.gateSummary(req.ctx!, req.params.societyId as string) })
  })
  router.get('/societies/:societyId/visits', ...atGate, async (req, res) => {
    const query = parseOrThrow(listVisitsSchema, req.query)
    res.json({ data: await service.listVisits(req.ctx!, req.params.societyId as string, query) })
  })
  router.post('/societies/:societyId/visits', ...register, validateBody(registerVisitAtGateSchema), async (req, res) => {
    res.status(201).json({ data: await service.registerVisit(req.ctx!, req.params.societyId as string, req.body) })
  })
  router.get('/societies/:societyId/visitor-lookup', ...register, async (req, res) => {
    const { phone } = parseOrThrow(visitorLookupSchema, req.query)
    res.json({ data: await service.lookupVisitor(req.ctx!, req.params.societyId as string, phone) })
  })
  router.get('/societies/:societyId/flat-directory', ...atGate, async (req, res) => {
    res.json({ data: await service.flatDirectory(req.ctx!, req.params.societyId as string) })
  })
  router.get('/societies/:societyId/gate-log', ...atGate, async (req, res) => {
    const { on } = parseOrThrow(gateLogSchema, req.query)
    res.json({ data: await service.gateLog(req.ctx!, req.params.societyId as string, on) })
  })
  router.get('/societies/:societyId/inside', ...atGate, async (req, res) => {
    res.json({ data: await service.listInside(req.ctx!, req.params.societyId as string) })
  })
  router.get('/societies/:societyId/passes/validate', ...validate, async (req, res) => {
    const { code } = parseOrThrow(entryCodeSchema, req.query)
    res.json({ data: await service.validatePass(req.ctx!, req.params.societyId as string, code) })
  })
  router.get('/societies/:societyId/staff-pass/:passCode', ...validate, async (req, res) => {
    res.json({ data: await service.staffByPassCode(req.ctx!, req.params.societyId as string, req.params.passCode as string) })
  })
  router.get('/societies/:societyId/vehicle-lookup/:number', ...atGate, async (req, res) => {
    res.json({ data: await flatService.findVehicle(req.ctx!, req.params.societyId as string, req.params.number as string) })
  })

  router.post('/visits/:id/entry', requireAuth, requirePermission('VISIT_ENTRY_RECORD'), validateBody(recordEntrySchema), async (req, res) => {
    res.json({ data: await service.recordEntry(req.ctx!, req.params.id as string, req.body.gateId) })
  })
  router.post('/visits/:id/exit', requireAuth, requirePermission('VISIT_EXIT'), async (req, res) => {
    res.json({ data: await service.recordExit(req.ctx!, req.params.id as string) })
  })
  // --- Staff movement ------------------------------------------------------
  router.get('/staff/:id/verification', ...validate, async (req, res) => {
    res.json({ data: await service.staffVerification(req.ctx!, req.params.id as string) })
  })
  router.get('/societies/:societyId/staff-inside', ...atGate, async (req, res) => {
    res.json({ data: await service.staffInside(req.ctx!, req.params.societyId as string) })
  })
  router.get('/societies/:societyId/staff-movements', ...movementHistory, async (req, res) => {
    const query = parseOrThrow(staffMovementHistorySchema, req.query)
    res.json({ data: await service.staffMovementHistory(req.ctx!, req.params.societyId as string, query) })
  })
  router.post('/staff/:id/movement/entry-rejection', ...validate, validateBody(staffRejectionSchema), async (req, res) => {
    res.status(201).json({ data: await service.rejectStaffEntry(req.ctx!, req.params.id as string, req.body) })
  })
  router.post('/staff/:id/entry', requireAuth, requirePermission('VISIT_ENTRY_RECORD'), validateBody(staffMovementSchema), async (req, res) => {
    res.status(201).json({ data: await service.recordStaffEntry(req.ctx!, req.params.id as string, req.body) })
  })
  router.post('/staff/:id/exit', requireAuth, requirePermission('VISIT_EXIT'), validateBody(staffMovementSchema), async (req, res) => {
    res.json({ data: await service.recordStaffExit(req.ctx!, req.params.id as string, req.body) })
  })

  // --- The resident's screens ----------------------------------------------
  router.get('/me/visits', ...ownFlat, async (req, res) => {
    res.json({ data: await service.listMyVisits(req.ctx!) })
  })
  // A guard with VISIT_DECIDE may answer after the intercom call; a resident answers for their flat
  router.post('/visits/:id/decision', requireAuth, requirePermission('VISITOR_APPROVE', 'VISIT_DECIDE'), validateBody(decideVisitSchema), async (req, res) => {
    res.json({ data: await service.decideVisit(req.ctx!, req.params.id as string, req.body) })
  })

  router.get('/me/passes', ...ownFlat, async (req, res) => {
    res.json({ data: await service.listMyPasses(req.ctx!) })
  })
  router.post('/flats/:flatId/passes', requireAuth, requirePermission('VISITOR_PASS_CREATE'), validateBody(createPassSchema), async (req, res) => {
    res.status(201).json({ data: await service.createPass(req.ctx!, { ...req.body, flatId: req.params.flatId as string }) })
  })
  router.post('/passes/:id/cancel', requireAuth, requirePermission('VISITOR_PASS_CREATE'), async (req, res) => {
    res.json({ data: await service.cancelPass(req.ctx!, req.params.id as string) })
  })

  router.get('/me/daily-help', ...ownFlatOrStaffOffice, async (req, res) => {
    res.json({ data: await service.listMyDailyHelp(req.ctx!) })
  })
  router.get('/staff/:id/attendance', ...ownFlatOrStaffOffice, async (req, res) => {
    res.json({ data: await service.listStaffAttendance(req.ctx!, req.params.id as string) })
  })
  router.post('/staff/:id/leave', ...ownFlatOrStaffOffice, validateBody(markLeaveSchema), async (req, res) => {
    res.status(201).json({ data: await service.markStaffLeave(req.ctx!, req.params.id as string, req.body.onDate) })
  })

  // --- Vehicles and requests to the office ---------------------------------
  router.get('/me/vehicles', ...ownFlatOrOffice, async (req, res) => {
    res.json({ data: await flatService.listMyVehicles(req.ctx!) })
  })
  router.post('/flats/:flatId/vehicles', ...ownFlatOrOffice, validateBody(addVehicleSchema), async (req, res) => {
    res.status(201).json({ data: await flatService.addVehicle(req.ctx!, req.params.flatId as string, req.body) })
  })
  router.delete('/vehicles/:id', ...ownFlatOrOffice, async (req, res) => {
    res.json({ data: await flatService.removeVehicle(req.ctx!, req.params.id as string) })
  })

  router.get('/me/access-requests', ...ownFlatOrOffice, async (req, res) => {
    res.json({ data: await flatService.listMyAccessRequests(req.ctx!) })
  })
  router.post('/me/access-requests', ...ownFlatOrOffice, validateBody(accessRequestSchema), async (req, res) => {
    res.status(201).json({ data: await flatService.createAccessRequest(req.ctx!, req.body) })
  })
  router.get('/societies/:societyId/access-requests', requireAuth, requirePermission('USER_MANAGE', 'STAFF_MANAGE'), async (req, res) => {
    const status = req.query.status as 'PENDING' | 'APPROVED' | 'REJECTED' | undefined
    res.json({ data: await flatService.listAccessRequests(req.ctx!, req.params.societyId as string, status) })
  })
  router.post('/access-requests/:id/decision', requireAuth, requirePermission('USER_MANAGE', 'STAFF_MANAGE'), validateBody(decideAccessRequestSchema), async (req, res) => {
    res.json({ data: await flatService.decideAccessRequest(req.ctx!, req.params.id as string, req.body) })
  })

  return router
}
