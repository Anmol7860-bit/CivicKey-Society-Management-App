import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { pushSubscriptions } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'

interface Subscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/**
 * Stores a browser's push subscription.
 *
 * Keyed by endpoint, which is what the push service recognises. The same endpoint arriving again
 * is the same browser: it is moved to the current user and reactivated rather than duplicated,
 * which is what happens when someone signs in as somebody else on a shared device.
 */
export async function savePushSubscription(userId: string, subscription: Subscription) {
  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, isActive: true },
    })
    .returning({ id: pushSubscriptions.id })
  return { id: row!.id }
}

/**
 * Stops pushing to one of this person's browsers, or to all of them.
 *
 * Ownership is part of the update rather than a check before it: an id belonging to somebody else
 * matches nothing and is answered 404, so the route cannot be used to find out whose it is.
 */
export async function removePushSubscription(userId: string, id: string | null) {
  const mine = eq(pushSubscriptions.userId, userId)
  const rows = await db
    .update(pushSubscriptions)
    .set({ isActive: false })
    .where(id ? and(mine, eq(pushSubscriptions.id, id)) : mine)
    .returning({ id: pushSubscriptions.id })
  if (id && rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'That push subscription does not exist')
  return { removed: rows.length }
}
