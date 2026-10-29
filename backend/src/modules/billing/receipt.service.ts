import { and, eq, lt, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { blocks, flats, invoices, payments, receipts, societies } from '../../db/schema.js'
import { logger } from '../../lib/logger.js'
import type { DbExecutor } from '../audit/audit.service.js'
import { storeBytes } from '../file/file.service.js'
import { enqueueNotification } from '../notification/outbox.service.js'
import { effectiveApprover } from '../gate/gate.service.js'
import { onePagePdf, type PdfLine } from './pdf.js'

/** Three tries, then the receipt stays FAILED and an admin can see why. */
const MAX_ATTEMPTS = 3

/**
 * Records that a settled payment has a receipt, which is rendered later.
 *
 * The row is written in the same transaction as the payment, so a receipt can never be missing
 * for settled money, and its unique payment_id makes a second one impossible.
 */
export async function issueReceipt(tx: DbExecutor, payment: { id: string; receiptNumber: string }, societyId: string) {
  const [row] = await tx
    .insert(receipts)
    .values({ paymentId: payment.id, societyId, number: payment.receiptNumber })
    .onConflictDoNothing()
    .returning({ id: receipts.id })
  return row?.id ?? null
}

const money = (value: string | number | null) => `₹${Number(value ?? 0).toFixed(2)}`

function receiptLines(data: {
  society: string
  number: string
  flat: string
  period: string
  receivedOn: string
  paidBy: string | null
  maintenance: string
  sinkingFund: string
  parkingCharge: string
  oneTimeDescription: string | null
  oneTimeAmount: string
  total: string | null
  amount: string
}): PdfLine[] {
  const lines: PdfLine[] = [
    { text: data.society, size: 16, bold: true },
    { text: 'Maintenance receipt', size: 12 },
    { text: '' },
    { text: `Receipt number: ${data.number}`, bold: true },
    { text: `Flat: ${data.flat}` },
    { text: `Period: ${data.period}` },
    { text: `Received on: ${data.receivedOn}` },
    { text: `Received from: ${data.paidBy ?? data.flat}` },
    { text: '' },
    { text: `Maintenance        ${money(data.maintenance)}` },
    { text: `Sinking fund       ${money(data.sinkingFund)}` },
    { text: `Parking            ${money(data.parkingCharge)}` },
  ]
  if (Number(data.oneTimeAmount) > 0) {
    lines.push({ text: `${(data.oneTimeDescription ?? 'One-time charge').slice(0, 40).padEnd(18)} ${money(data.oneTimeAmount)}` })
  }
  lines.push(
    { text: `Invoice total      ${money(data.total)}` },
    { text: '' },
    { text: `Amount received    ${money(data.amount)}`, size: 13, bold: true },
    { text: '' },
    { text: 'This receipt is issued by the society office through CivicKey.', size: 9 },
  )
  return lines
}

/**
 * Renders the receipts that are still waiting for a PDF.
 *
 * Each row is claimed by the same update that counts the attempt, so two processes never render
 * the same receipt, and a render that keeps failing stops after three tries instead of looping.
 * RECEIPT_READY is only enqueued once the file exists, which is what the email promises.
 */
export async function renderPendingReceipts() {
  const pending = await db
    .select({
      id: receipts.id,
      number: receipts.number,
      societyId: receipts.societyId,
      society: societies.name,
      flat: sql<string>`${blocks.name} || '-' || ${flats.number}`,
      flatId: invoices.flatId,
      period: invoices.period,
      maintenance: invoices.maintenance,
      sinkingFund: invoices.sinkingFund,
      parkingCharge: invoices.parkingCharge,
      oneTimeDescription: invoices.oneTimeDescription,
      oneTimeAmount: invoices.oneTimeAmount,
      total: invoices.total,
      amount: payments.amount,
      receivedOn: payments.receivedOn,
      paidBy: payments.paidBy,
    })
    .from(receipts)
    .innerJoin(payments, eq(payments.id, receipts.paymentId))
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .innerJoin(flats, eq(flats.id, invoices.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(societies, eq(societies.id, receipts.societyId))
    .where(and(eq(receipts.status, 'PENDING_PDF'), lt(receipts.attempts, MAX_ATTEMPTS)))
    .limit(20)

  let rendered = 0
  for (const row of pending) {
    // Claiming and counting the attempt in one update is what keeps two renders apart
    const claimed = await db
      .update(receipts)
      .set({ attempts: sql`${receipts.attempts} + 1`, updatedAt: new Date() })
      .where(and(eq(receipts.id, row.id), eq(receipts.status, 'PENDING_PDF'), lt(receipts.attempts, MAX_ATTEMPTS)))
      .returning({ attempts: receipts.attempts })
    if (claimed.length === 0) continue

    try {
      const fileId = await storeBytes(row.societyId, 'application/pdf', onePagePdf(receiptLines(row)))
      const approver = await effectiveApprover(row.flatId)
      await db.transaction(async (tx) => {
        await tx
          .update(receipts)
          .set({ status: 'READY', fileId, failureReason: null, updatedAt: new Date() })
          .where(eq(receipts.id, row.id))
        if (approver) {
          await enqueueNotification(tx, {
            societyId: row.societyId,
            eventType: 'RECEIPT_READY',
            entityType: 'receipt',
            entityId: row.id,
            recipientIds: [approver.userId],
            payload: { number: row.number, flat: row.flat, amount: Number(row.amount) },
          })
        }
      })
      rendered += 1
    } catch (error) {
      logger.error({ err: error, receiptId: row.id }, 'A receipt PDF could not be rendered')
      const failed = claimed[0]!.attempts >= MAX_ATTEMPTS
      await db
        .update(receipts)
        .set({
          status: failed ? 'FAILED' : 'PENDING_PDF',
          failureReason: String(error).slice(0, 300),
          updatedAt: new Date(),
        })
        .where(eq(receipts.id, row.id))
    }
  }
  return rendered
}
