import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { AppError } from '../../lib/errors.js'
import { requireAuth } from '../../middleware/requireAuth.js'
import { parseOrThrow, validateBody } from '../../middleware/validateBody.js'
import { listNotifications, markRead, unreadCount } from './dispatcher.js'
import { savePushSubscription, removePushSubscription } from './push.service.js'

/** One page of history. The defaults are the subtask's: page 1, twenty at a time. */
const listQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
})

/** An id that is not even a uuid names nothing, so it is a 404 rather than a failed query. */
function uuidOr404(value: string, what: string) {
  if (!z.uuid().safeParse(value).success) throw new AppError(404, 'NOT_FOUND', `That ${what} does not exist`)
  return value
}

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
    const query = parseOrThrow(listQuerySchema, req.query)
    const [items, unread] = await Promise.all([listNotifications(req.ctx!.userId, query), unreadCount(req.ctx!.userId)])
    res.json({ data: { items, unread, page: query.page, limit: query.limit } })
  })

  router.patch('/notifications/read-all', requireAuth, async (req, res) => {
    res.json({ data: await markRead(req.ctx!.userId) })
  })

  router.patch('/notifications/:id/read', requireAuth, async (req, res) => {
    res.json({ data: await markRead(req.ctx!.userId, uuidOr404(req.params.id as string, 'notification')) })
  })

  /** The browser needs this to subscribe. Public by design: it is a public key. */
  router.get('/notifications/push-key', (_req, res) => {
    res.json({ data: { publicKey: env.VAPID_PUBLIC_KEY ?? null } })
  })

  router.post('/notifications/push-subscription', requireAuth, validateBody(subscriptionSchema), async (req, res) => {
    res.status(201).json({ data: await savePushSubscription(req.ctx!.userId, req.body) })
  })

  /** One device stops. Without an id, every device this person has: what a sign-out wants. */
  router.delete('/notifications/push-subscription/:id', requireAuth, async (req, res) => {
    res.json({ data: await removePushSubscription(req.ctx!.userId, uuidOr404(req.params.id as string, 'push subscription')) })
  })

  router.delete('/notifications/push-subscription', requireAuth, async (req, res) => {
    res.json({ data: await removePushSubscription(req.ctx!.userId, null) })
  })

  return router
}
