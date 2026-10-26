import { and, desc, eq, isNull, sql, sum } from 'drizzle-orm'
import { env } from '../../config/env.js'
import { db } from '../../db/client.js'
import { gatewayEvents, invoices, paymentAttempts, payments, receipts } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { assertFlatAccess, assertState, requireRecord, UUID } from '../access/scope.js'
import { recordAuditEvent } from '../audit/audit.service.js'
import { settleInFull } from './billing.service.js'
import { checkoutConfigured, createOrder, signatureMatches } from './gateway.js'

const toPaise = (rupees: number) => Math.round(rupees * 100)

async function outstandingPaise(invoiceId: string, totalPaise: number) {
  const [row] = await db
    .select({ paid: sum(payments.amount) })
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), isNull(payments.reversedAt)))
  return totalPaise - toPaise(Number(row?.paid ?? 0))
}

/**
 * Starts a hosted checkout for the whole outstanding amount of one of the resident's own invoices.
 *
 * The amount is read from the invoice, never from the request, and what comes back is only what
 * the browser needs to open the gateway's own page. Nothing here marks anything paid: the
 * attempt sits at CREATED until a signed webhook says otherwise.
 */
export async function startCheckout(ctx: AuthContext, invoiceId: string) {
  const [invoice] = UUID.test(invoiceId) ? await db.select().from(invoices).where(eq(invoices.id, invoiceId)) : []
  await requireRecord(ctx, invoice, 'Invoice')
  // A resident pays their own flat's bill; the billing panel may pay for any flat it bills
  await assertFlatAccess(ctx, invoice!.flatId, { write: true, scopePermission: 'INVOICE_GENERATE' })
  assertState(invoice!.status !== 'CANCELLED', 'This invoice has been cancelled')
  assertState(invoice!.status !== 'PAID', 'This invoice is already paid in full')
  if (!checkoutConfigured()) {
    throw new AppError(503, 'PAYMENT_NOT_CONFIGURED', 'Online payment is not set up for this society yet.')
  }

  const amountPaise = await outstandingPaise(invoice!.id, toPaise(Number(invoice!.total ?? 0)))
  assertState(amountPaise > 0, 'This invoice is already paid in full')

  const [attempt] = await db
    .insert(paymentAttempts)
    .values({ invoiceId: invoice!.id, societyId: invoice!.societyId, amountPaise, startedBy: ctx.userId })
    .returning()
  const order = await createOrder(invoice!.id, amountPaise).catch(async (error: unknown) => {
    await db
      .update(paymentAttempts)
      .set({ status: 'FAILED', failureReason: String(error).slice(0, 300), updatedAt: new Date() })
      .where(eq(paymentAttempts.id, attempt!.id))
    throw error
  })
  await db
    .update(paymentAttempts)
    .set({ status: 'CREATED', providerOrderId: order.id, updatedAt: new Date() })
    .where(eq(paymentAttempts.id, attempt!.id))
  await recordAuditEvent(db, {
    eventType: 'PAYMENT_CHECKOUT_STARTED',
    actorUserId: ctx.userId,
    metadata: { societyId: invoice!.societyId, invoiceId: invoice!.id, attemptId: attempt!.id, orderId: order.id },
  })

  return {
    attemptId: attempt!.id,
    orderId: order.id,
    amount: amountPaise / 100,
    currency: order.currency,
    keyId: env.RAZORPAY_KEY_ID!,
  }
}

interface RazorpayEntity {
  id?: string
  order_id?: string
  amount?: number
  currency?: string
  error_description?: string
}

interface RazorpayWebhook {
  event?: string
  payload?: { payment?: { entity?: RazorpayEntity }; order?: { entity?: RazorpayEntity } }
}

/** The gateway's own delivery id, which is what makes handling it exactly once possible. */
const eventIdOf = (headerId: string | undefined, body: RazorpayWebhook) =>
  headerId ?? body.payload?.payment?.entity?.id ?? body.payload?.order?.entity?.id ?? null

/**
 * Handles one webhook from the gateway. This is the only thing that settles an online payment.
 *
 * The signature is checked against the raw bytes before the body is read as anything at all, the
 * event is stored under the gateway's delivery id so a retry changes nothing, and an amount that
 * does not match what was asked for leaves the attempt REVIEW_REQUIRED and the invoice unpaid.
 */
export async function handleWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
  const signature = headers['x-razorpay-signature']
  if (!signatureMatches(rawBody, typeof signature === 'string' ? signature : undefined)) {
    throw new AppError(401, 'TOKEN_INVALID', 'That webhook is not signed by the payment gateway.')
  }

  let body: RazorpayWebhook
  try {
    body = JSON.parse(rawBody.toString('utf8')) as RazorpayWebhook
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'That webhook body is not JSON.')
  }
  const deliveryId = eventIdOf(
    typeof headers['x-razorpay-event-id'] === 'string' ? (headers['x-razorpay-event-id'] as string) : undefined,
    body,
  )
  if (!deliveryId || !body.event) throw new AppError(400, 'VALIDATION_ERROR', 'That webhook has no event to handle.')

  const [stored] = await db
    .insert(gatewayEvents)
    .values({ providerEventId: deliveryId, eventType: body.event, payload: body })
    .onConflictDoNothing()
    .returning({ id: gatewayEvents.id })
  // A retry of something already handled is a success, not an error: the gateway must stop asking
  if (!stored) return { handled: false, reason: 'DUPLICATE' as const }

  const result = await apply(body).catch((error: unknown) => {
    logger.error({ err: error, event: body.event }, 'A payment webhook could not be applied')
    return 'ERROR' as const
  })
  await db
    .update(gatewayEvents)
    .set({ handledAt: new Date(), result })
    .where(eq(gatewayEvents.id, stored.id))
  if (result === 'ERROR') throw new AppError(500, 'INTERNAL_ERROR', 'That webhook could not be applied.')
  return { handled: true, reason: result }
}

type Applied = 'SETTLED' | 'FAILED' | 'REVIEW_REQUIRED' | 'IGNORED' | 'ALREADY_SETTLED'

async function apply(body: RazorpayWebhook): Promise<Applied> {
  const entity = body.payload?.payment?.entity ?? body.payload?.order?.entity
  const orderId = body.payload?.payment?.entity?.order_id ?? body.payload?.order?.entity?.id
  if (!orderId) return 'IGNORED'

  const [attempt] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.providerOrderId, orderId))
  if (!attempt) return 'IGNORED'

  if (body.event === 'payment.failed') {
    await db
      .update(paymentAttempts)
      .set({
        status: 'FAILED',
        providerPaymentId: entity?.id ?? null,
        failureReason: (entity?.error_description ?? 'The gateway refused the payment').slice(0, 300),
        updatedAt: new Date(),
      })
      .where(and(eq(paymentAttempts.id, attempt.id), sql`${paymentAttempts.status} <> 'SUCCESS'`))
    return 'FAILED'
  }
  if (body.event !== 'payment.captured' && body.event !== 'order.paid') return 'IGNORED'
  if (attempt.status === 'SUCCESS') return 'ALREADY_SETTLED'

  // What the gateway captured must be exactly what this attempt asked for, in rupees
  const captured = entity?.amount
  if (captured !== attempt.amountPaise || (entity?.currency && entity.currency !== 'INR')) {
    await db
      .update(paymentAttempts)
      .set({
        status: 'REVIEW_REQUIRED',
        providerPaymentId: entity?.id ?? null,
        failureReason: `Captured ${String(captured)} ${entity?.currency ?? 'INR'} against ${attempt.amountPaise} INR`,
        updatedAt: new Date(),
      })
      .where(eq(paymentAttempts.id, attempt.id))
    await recordAuditEvent(db, {
      eventType: 'PAYMENT_REVIEW_REQUIRED',
      actorUserId: null,
      metadata: { invoiceId: attempt.invoiceId, attemptId: attempt.id, captured, expected: attempt.amountPaise },
    })
    return 'REVIEW_REQUIRED'
  }

  await db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, attempt.invoiceId)).for('update')
    const settlement = await settleInFull(tx, invoice!, {
      amountPaise: attempt.amountPaise,
      receivedOn: new Date().toISOString().slice(0, 10),
      note: `Razorpay ${entity?.id ?? attempt.providerOrderId}`,
      recordedBy: attempt.startedBy,
    })
    await tx
      .update(paymentAttempts)
      .set({ status: 'SUCCESS', providerPaymentId: entity?.id ?? null, updatedAt: new Date() })
      .where(eq(paymentAttempts.id, attempt.id))
    await recordAuditEvent(tx, {
      eventType: 'PAYMENT_RECORDED',
      actorUserId: attempt.startedBy,
      metadata: {
        societyId: attempt.societyId,
        invoiceId: attempt.invoiceId,
        paymentId: settlement.payment.id,
        receiptNumber: settlement.payment.receiptNumber,
        amount: attempt.amountPaise / 100,
        method: 'RAZORPAY',
      },
    })
  })
  return 'SETTLED'
}

/** The receipts for one of the resident's own invoices, newest first. */
export async function listReceipts(ctx: AuthContext, invoiceId: string) {
  const [invoice] = UUID.test(invoiceId) ? await db.select().from(invoices).where(eq(invoices.id, invoiceId)) : []
  await requireRecord(ctx, invoice, 'Invoice')
  await assertFlatAccess(ctx, invoice!.flatId, { scopePermission: 'INVOICE_GENERATE' })
  return db
    .select({
      id: receipts.id,
      number: receipts.number,
      status: receipts.status,
      amount: payments.amount,
      receivedOn: payments.receivedOn,
      createdAt: receipts.createdAt,
    })
    .from(receipts)
    .innerJoin(payments, eq(payments.id, receipts.paymentId))
    .where(eq(payments.invoiceId, invoiceId))
    .orderBy(desc(receipts.createdAt))
}

/** The stored PDF of a receipt, once it has been rendered. */
export async function receiptFile(ctx: AuthContext, receiptId: string) {
  const [row] = UUID.test(receiptId)
    ? await db
        .select({ receipt: receipts, flatId: invoices.flatId })
        .from(receipts)
        .innerJoin(payments, eq(payments.id, receipts.paymentId))
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(eq(receipts.id, receiptId))
    : []
  await requireRecord(ctx, row && { societyId: row.receipt.societyId }, 'Receipt')
  await assertFlatAccess(ctx, row!.flatId, { scopePermission: 'INVOICE_GENERATE' })
  assertState(row!.receipt.status === 'READY' && row!.receipt.fileId !== null, 'This receipt is still being prepared')
  return { fileId: row!.receipt.fileId!, number: row!.receipt.number }
}
