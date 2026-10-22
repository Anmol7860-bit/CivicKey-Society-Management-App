import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody } from '../../middleware/validateBody.js'
import {
  createBlockSchema,
  createFlatSchema,
  createFloorSchema,
  createGateSchema,
  updateGateSchema,
  updateBlockSchema,
  updateFlatSchema,
  updateFloorSchema,
  updateSocietySchema,
} from './society.schemas.js'
import * as service from './society.service.js'

/** Society structure: society → blocks → floors → flats. Mounted at /api/v1. */
export function createSocietyRouter() {
  const router = Router()
  // Scope (the Admin's society) is read from the database by requirePermission, never the request
  const manage = [requireAuth, requirePermission('SOCIETY_MANAGE')]

  router.get('/societies', ...manage, async (req, res) => {
    res.json({ data: await service.listSocieties(req.ctx!) })
  })
  router.get('/societies/:societyId', ...manage, async (req, res) => {
    res.json({ data: await service.getSociety(req.ctx!, req.params.societyId as string) })
  })
  router.put('/societies/:societyId', ...manage, validateBody(updateSocietySchema), async (req, res) => {
    res.json({ data: await service.updateSociety(req.ctx!, req.params.societyId as string, req.body) })
  })

  /** The selling view: the whole hierarchy with what is sold, occupied and open to sharing */
  router.get('/societies/:societyId/occupancy', ...manage, async (req, res) => {
    res.json({ data: await service.getOccupancy(req.ctx!, req.params.societyId as string) })
  })

  router.get('/societies/:societyId/gates', ...manage, async (req, res) => {
    res.json({ data: await service.listGates(req.ctx!, req.params.societyId as string) })
  })
  router.post('/societies/:societyId/gates', ...manage, validateBody(createGateSchema), async (req, res) => {
    res.status(201).json({ data: await service.createGate(req.ctx!, req.params.societyId as string, req.body) })
  })
  router.put('/gates/:gateId', ...manage, validateBody(updateGateSchema), async (req, res) => {
    res.json({ data: await service.updateGate(req.ctx!, req.params.gateId as string, req.body) })
  })

  router.get('/societies/:societyId/blocks', ...manage, async (req, res) => {
    res.json({ data: await service.listBlocks(req.ctx!, req.params.societyId as string) })
  })
  router.post('/societies/:societyId/blocks', ...manage, validateBody(createBlockSchema), async (req, res) => {
    res.status(201).json({ data: await service.createBlock(req.ctx!, req.params.societyId as string, req.body) })
  })
  router.put('/blocks/:blockId', ...manage, validateBody(updateBlockSchema), async (req, res) => {
    res.json({ data: await service.updateBlock(req.ctx!, req.params.blockId as string, req.body) })
  })

  router.get('/blocks/:blockId/floors', ...manage, async (req, res) => {
    res.json({ data: await service.listFloors(req.ctx!, req.params.blockId as string) })
  })
  router.post('/blocks/:blockId/floors', ...manage, validateBody(createFloorSchema), async (req, res) => {
    res.status(201).json({ data: await service.createFloor(req.ctx!, req.params.blockId as string, req.body) })
  })
  router.put('/floors/:floorId', ...manage, validateBody(updateFloorSchema), async (req, res) => {
    res.json({ data: await service.updateFloor(req.ctx!, req.params.floorId as string, req.body) })
  })

  router.get('/floors/:floorId/flats', ...manage, async (req, res) => {
    res.json({ data: await service.listFlats(req.ctx!, req.params.floorId as string) })
  })
  router.post('/floors/:floorId/flats', ...manage, validateBody(createFlatSchema), async (req, res) => {
    res.status(201).json({ data: await service.createFlat(req.ctx!, req.params.floorId as string, req.body) })
  })
  router.get('/flats/:flatId', ...manage, async (req, res) => {
    res.json({ data: await service.getFlat(req.ctx!, req.params.flatId as string) })
  })
  router.put('/flats/:flatId', ...manage, validateBody(updateFlatSchema), async (req, res) => {
    res.json({ data: await service.updateFlat(req.ctx!, req.params.flatId as string, req.body) })
  })

  return router
}
