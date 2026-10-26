import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody } from '../../middleware/validateBody.js'
import { syncEventSchema } from './sync.schemas.js'
import * as service from './sync.service.js'

/**
 * Where a guard's offline queue drains. One event per request: the device has no idea which of
 * them the server already has, so each carries its own id and is answered on its own.
 */
export function createSyncRouter() {
  const router = Router()
  // Any gate-recording permission gets in; applyEvent then checks the one this operation needs
  const atGate = [requireAuth, requirePermission('VISIT_REGISTER', 'VISIT_ENTRY_RECORD', 'VISIT_EXIT')]

  router.post('/sync/events', ...atGate, validateBody(syncEventSchema), async (req, res) => {
    res.json({ data: await service.applyEvent(req.ctx!, req.body) })
  })

  return router
}
