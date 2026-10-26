import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody } from '../../middleware/validateBody.js'
import { syncBatchSchema } from './sync.schemas.js'
import * as service from './sync.service.js'

/**
 * Where a guard's offline queue drains. The device sends a batch; each event is answered on its
 * own, because the device cannot know which of them the server already has.
 */
export function createSyncRouter() {
  const router = Router()
  // Any gate-recording permission gets in; each event then checks the one its operation needs
  const atGate = [requireAuth, requirePermission('VISIT_REGISTER', 'VISIT_ENTRY_RECORD', 'VISIT_EXIT', 'VISIT_DECIDE')]
  const review = [requireAuth, requirePermission('AUDIT_VIEW', 'USER_MANAGE')]

  router.post('/sync/events', ...atGate, validateBody(syncBatchSchema), async (req, res) => {
    res.json({ data: await service.applyBatch(req.ctx!, req.body) })
  })
  router.get('/sync/needs-review', ...review, async (req, res) => {
    res.json({ data: await service.listForReview(req.ctx!) })
  })

  return router
}
