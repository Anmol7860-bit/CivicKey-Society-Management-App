import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { requireAuth } from '../../middleware/requireAuth.js'
import { validateBody } from '../../middleware/validateBody.js'
import { listNotifications, markRead, unreadCount } from './dispatcher.js'
import { savePushSubscription, removePushSubscription } from './push.service.js'

const subscriptionSchema = z.strictObject({
  endpoint: z.url().max(1000),
  keys: z.strictObject({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) }),
})

/**
 * A person's own notifications. Every route is scoped to the signed-in user by the service, not
 * by anything in the request: there is no way to ask for someone else's.
 */
export function createNotificationRouter() {
  const router = Router()

  router.get('/notifications', requireAuth, async (req, res) => {
    const [items, unread] = await Promise.all([listNotifications(req.ctx!.userId), unreadCount(req.ctx!.userId)])
    res.json({ data: { items, unread } })
  })

  router.post('/notifications/read', requireAuth, async (req, res) => {
    res.json({ data: await markRead(req.ctx!.userId) })
  })

  router.post('/notifications/:id/read', requireAuth, async (req, res) => {
    res.json({ data: await markRead(req.ctx!.userId, req.params.id as string) })
  })

  /** The browser needs this to subscribe. Public by design: it is a public key. */
  router.get('/notifications/push-key', (_req, res) => {
    res.json({ data: { publicKey: env.VAPID_PUBLIC_KEY ?? null } })
  })

  router.post('/notifications/push', requireAuth, validateBody(subscriptionSchema), async (req, res) => {
    res.status(201).json({ data: await savePushSubscription(req.ctx!.userId, req.body) })
  })

  router.delete('/notifications/push', requireAuth, async (req, res) => {
    const endpoint = typeof req.query.endpoint === 'string' ? req.query.endpoint : null
    res.json({ data: await removePushSubscription(req.ctx!.userId, endpoint) })
  })

  return router
}
