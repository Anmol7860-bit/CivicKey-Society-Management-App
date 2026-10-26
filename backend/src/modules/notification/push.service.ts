import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { pushSubscriptions } from '../../db/schema.js'

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

/** Stops pushing to one of this person's browsers, or to all of them. */
export async function removePushSubscription(userId: string, endpoint: string | null) {
  const mine = eq(pushSubscriptions.userId, userId)
  const rows = await db
    .update(pushSubscriptions)
    .set({ isActive: false })
    .where(endpoint ? and(mine, eq(pushSubscriptions.endpoint, endpoint)) : mine)
    .returning({ id: pushSubscriptions.id })
  return { removed: rows.length }
}
