import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { parseOrThrow, validateBody } from '../../middleware/validateBody.js'
import { createTaskSchema, listTasksSchema, taskStatusSchema, updateTaskSchema } from './task.schemas.js'
import * as service from './task.service.js'

/**
 * Community tasks: the society's own work list. Managed by whoever runs the society, so it is
 * gated on SOCIETY_MANAGE rather than a permission of its own.
 */
export function createTaskRouter() {
  const router = Router()
  const manage = [requireAuth, requirePermission('SOCIETY_MANAGE')]

  router.get('/societies/:societyId/tasks', ...manage, async (req, res) => {
    const query = parseOrThrow(listTasksSchema, req.query)
    res.json({ data: await service.listTasks(req.ctx!, req.params.societyId as string, query) })
  })
  router.get('/societies/:societyId/task-summary', ...manage, async (req, res) => {
    res.json({ data: await service.taskSummary(req.ctx!, req.params.societyId as string) })
  })
  router.post('/societies/:societyId/tasks', ...manage, validateBody(createTaskSchema), async (req, res) => {
    res.status(201).json({ data: await service.createTask(req.ctx!, req.params.societyId as string, req.body) })
  })
  router.get('/tasks/:id', ...manage, async (req, res) => {
    res.json({ data: await service.getTask(req.ctx!, req.params.id as string) })
  })
  /** What has happened to the task, read from the audit rows written with each change */
  router.get('/tasks/:id/history', ...manage, async (req, res) => {
    res.json({ data: await service.taskHistory(req.ctx!, req.params.id as string) })
  })
  router.put('/tasks/:id', ...manage, validateBody(updateTaskSchema), async (req, res) => {
    res.json({ data: await service.updateTask(req.ctx!, req.params.id as string, req.body) })
  })
  router.post('/tasks/:id/status', ...manage, validateBody(taskStatusSchema), async (req, res) => {
    res.json({ data: await service.setTaskStatus(req.ctx!, req.params.id as string, req.body) })
  })

  return router
}
