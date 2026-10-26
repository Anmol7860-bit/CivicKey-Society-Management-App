import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../../config/env.js'
import { AppError } from '../../lib/errors.js'

const ORDERS_URL = 'https://api.razorpay.com/v1/orders'

export const checkoutConfigured = () => Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)

export interface GatewayOrder {
  id: string
  amount: number
  currency: string
}

/**
 * Creates a hosted-checkout order for an exact amount in paise.
 *
 * The amount is decided here and sent to the gateway, never taken from the browser, and the
 * invoice id travels as the receipt so a webhook can be matched back without trusting the client.
 */
export async function createOrder(invoiceId: string, amountPaise: number): Promise<GatewayOrder> {
  if (!checkoutConfigured()) {
    throw new AppError(503, 'PAYMENT_NOT_CONFIGURED', 'Online payment is not set up for this society yet.')
  }
  const credentials = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')
  const res = await fetch(ORDERS_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: invoiceId, payment_capture: 1 }),
  })
  const body = (await res.json().catch(() => null)) as { id?: string; amount?: number; currency?: string } | null
  if (!res.ok || !body?.id) {
    throw new AppError(502, 'PAYMENT_GATEWAY_ERROR', 'The payment gateway could not start this payment. Try again.')
  }
  return { id: body.id, amount: body.amount ?? amountPaise, currency: body.currency ?? 'INR' }
}

/**
 * Whether a webhook really came from the gateway, checked against the raw body.
 *
 * The signature covers the exact bytes that were sent, so the body must not be re-serialised
 * first: a parsed and re-encoded object differs in key order and spacing and never verifies.
 */
export function signatureMatches(rawBody: Buffer, signature: string | undefined) {
  if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false
  const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex')
  const given = Buffer.from(signature, 'utf8')
  const mine = Buffer.from(expected, 'utf8')
  return given.length === mine.length && timingSafeEqual(given, mine)
}
