import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import type { NotificationEvent } from './outbox.service.js'

/**
 * Which events go out by email. The baseline names exactly three, and the restraint is the point:
 * a visitor at the gate is urgent and belongs on the phone, not in an inbox an hour later.
 */
export const EMAIL_EVENTS: readonly NotificationEvent[] = ['RECEIPT_READY', 'BILL_DUE_SOON', 'BILL_OVERDUE']

export interface Recipient {
  userId: string
  email: string | null
}

export interface PushTarget {
  id: string
  endpoint: string
  p256dh: string
  auth: string
}

/** Raised when a channel failed in a way worth retrying, as opposed to one that never will. */
export class ChannelError extends Error {
  readonly permanent: boolean

  constructor(message: string, permanent = false) {
    super(message)
    this.name = 'ChannelError'
    this.permanent = permanent
  }
}

/**
 * Sends one transactional email through Brevo.
 *
 * Nothing is sent when the key is unset, which is the normal state in development: the delivery
 * is marked skipped rather than failed, so a local run does not fill up with dead rows.
 */
export async function sendEmail(to: string, subject: string, text: string) {
  if (!env.BREVO_API_KEY) return { skipped: true as const }
  let res: Response
  try {
    res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: env.EMAIL_FROM_NAME, email: env.EMAIL_FROM_ADDRESS },
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
    })
  } catch (error) {
    throw new ChannelError(`Brevo unreachable: ${(error as Error).message}`)
  }
  if (res.ok) return { skipped: false as const }
  // The provider rejected the message itself; retrying the same message will be rejected again
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new ChannelError(`Brevo refused the message (${res.status})`, true)
  }
  throw new ChannelError(`Brevo failed (${res.status})`)
}

let webPush: typeof import('web-push') | null = null

/** Loaded on first use and only when configured, so a deployment without push needs no keys. */
async function pushClient() {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null
  if (!webPush) {
    webPush = (await import('web-push')).default
    webPush.setVapidDetails(`mailto:${env.EMAIL_FROM_ADDRESS}`, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY)
  }
  return webPush
}

/**
 * Pushes to one browser. A 404 or 410 means the browser threw the subscription away, which is
 * permanent and the caller deactivates it; anything else is worth another try.
 */
export async function sendPush(target: PushTarget, body: { title: string; body: string; url?: string }) {
  const client = await pushClient()
  if (!client) return { skipped: true as const }
  try {
    await client.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(body),
    )
    return { skipped: false as const }
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode
    if (status === 404 || status === 410) throw new ChannelError('The browser dropped this subscription', true)
    logger.debug({ err: error, endpoint: target.endpoint.slice(0, 40) }, 'Web Push failed')
    throw new ChannelError(`Web Push failed (${status ?? 'no status'})`)
  }
}
