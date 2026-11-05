import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { parseOrThrow, validateBody } from '../../middleware/validateBody.js'
import {
  addMemberSchema,
  archiveGroupSchema,
  createGroupSchema,
  listGroupsSchema,
  listMessagesSchema,
  postMessageSchema,
} from './community.schemas.js'
import * as service from './community.service.js'

/**
 * Community groups: the space the residents and the office share. The office holds GROUP_MANAGE,
 * every resident holds COMMUNITY_POST, and either one gets through the reading and membership
 * routes - the service then decides what each may do, since a leader's power over their own group
 * comes from their membership row and not from a permission.
 */
export function createCommunityRouter() {
  const router = Router()
  const manage = [requireAuth, requirePermission('GROUP_MANAGE')]
  const inTheSociety = [requireAuth, requirePermission('GROUP_MANAGE', 'COMMUNITY_POST')]

  router.get('/societies/:societyId/groups', ...inTheSociety, async (req, res) => {
    const query = parseOrThrow(listGroupsSchema, req.query)
    res.json({ data: await service.listGroups(req.ctx!, req.params.societyId as string, query) })
  })
  router.post('/societies/:societyId/groups', ...manage, validateBody(createGroupSchema), async (req, res) => {
    res.status(201).json({ data: await service.createGroup(req.ctx!, req.params.societyId as string, req.body) })
  })
  router.post('/groups/:id/archive', ...manage, validateBody(archiveGroupSchema), async (req, res) => {
    res.json({ data: await service.archiveGroup(req.ctx!, req.params.id as string, req.body) })
  })

  router.get('/groups/:id/members', ...inTheSociety, async (req, res) => {
    res.json({ data: await service.listMembers(req.ctx!, req.params.id as string) })
  })
  router.post('/groups/:id/members', ...inTheSociety, validateBody(addMemberSchema), async (req, res) => {
    res.status(201).json({ data: await service.addMember(req.ctx!, req.params.id as string, req.body) })
  })
  router.delete('/groups/:id/members/:userId', ...inTheSociety, async (req, res) => {
    res.json({ data: await service.removeMember(req.ctx!, req.params.id as string, req.params.userId as string) })
  })

  router.get('/groups/:id/messages', ...inTheSociety, async (req, res) => {
    const query = parseOrThrow(listMessagesSchema, req.query)
    res.json({ data: await service.listMessages(req.ctx!, req.params.id as string, query) })
  })
  router.post('/groups/:id/messages', ...inTheSociety, validateBody(postMessageSchema), async (req, res) => {
    res.status(201).json({ data: await service.postMessage(req.ctx!, req.params.id as string, req.body) })
  })
  /** The author takes back their own; the office removes anyone's */
  router.delete('/messages/:id', ...inTheSociety, async (req, res) => {
    res.json({ data: await service.removeMessage(req.ctx!, req.params.id as string) })
  })

  return router
}
