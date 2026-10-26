import { getPushKey, savePushSubscription } from './api'

/** The VAPID key arrives as base64url and the browser wants raw bytes. */
function decodeKey(base64: string) {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/**
 * Asks the browser for permission and registers this device for push.
 *
 * Every step can be unavailable for an ordinary reason - no service worker, no VAPID key on the
 * server, permission refused, a browser that has no push at all - and each of those is a plain
 * "not subscribed", not an error. The app works without push; push only makes it louder.
 */
export async function enablePush(token: string): Promise<{ subscribed: boolean; reason?: string }> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return { subscribed: false, reason: 'UNSUPPORTED' }

  const { publicKey } = await getPushKey(token)
  if (!publicKey) return { subscribed: false, reason: 'NOT_CONFIGURED' }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { subscribed: false, reason: 'DENIED' }

  const registration = await navigator.serviceWorker.register('/sw.js')
  // An existing subscription is reused: the server keys on the endpoint, so re-sending it is safe
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(publicKey) }))

  const raw = subscription.toJSON()
  if (!raw.endpoint || !raw.keys?.p256dh || !raw.keys?.auth) return { subscribed: false, reason: 'INCOMPLETE' }

  await savePushSubscription(token, { endpoint: raw.endpoint, keys: { p256dh: raw.keys.p256dh, auth: raw.keys.auth } })
  return { subscribed: true }
}

/** Whether this browser is already subscribed, without asking for anything. */
export async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'UNSUPPORTED' as const
  if (Notification.permission === 'denied') return 'DENIED' as const
  const registration = await navigator.serviceWorker.getRegistration('/sw.js')
  const subscription = await registration?.pushManager.getSubscription()
  return subscription ? ('ON' as const) : ('OFF' as const)
}
