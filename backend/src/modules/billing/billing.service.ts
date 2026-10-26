import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, sum } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { billingRates, blocks, flatResidents, flats, floors, invoices, payments, societies } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { assertState, requireRecord, UUID } from '../access/scope.js'
import { recordAuditEvent, type AuditEventType, type DbExecutor } from '../audit/audit.service.js'
import { effectiveApprover } from '../gate/gate.service.js'
import { enqueueNotification } from '../notification/outbox.service.js'
import { issueReceipt } from './receipt.service.js'
import type {
  GenerateInvoicesBody,
  ListInvoicesQuery,
  RecordPaymentBody,
  ReportQuery,
  ReversePaymentBody,
  SetRatesBody,
} from './billing.schemas.js'

// Money is held in paise while it is being worked out, so a rate per sq ft never drifts by a
// fraction of a rupee, and written to the numeric columns as a fixed two-decimal string.
const toPaise = (rupees: number) => Math.round(rupees * 100)
const fromPaise = (paise: number) => paise / 100
const asAmount = (paise: number) => (paise / 100).toFixed(2)
/** numeric columns come back as strings; responses carry them as numbers */
const amount = (value: string | null) => Number(value ?? 0)

function audit(tx: DbExecutor, ctx: AuthContext, eventType: AuditEventType, metadata: Record<string, unknown>) {
  return recordAuditEvent(tx, { eventType, actorUserId: ctx.userId, metadata })
}

async function loadSociety(executor: DbExecutor, ctx: AuthContext, id: string) {
  const [row] = UUID.test(id) ? await executor.select().from(societies).where(eq(societies.id, id)) : []
  await requireRecord(ctx, row && { societyId: row.id }, 'Society')
  return row!
}

/** 404 when missing, 403 CROSS_SOCIETY_ACCESS outside the Admin's society. */
async function loadInvoice(executor: DbExecutor, ctx: AuthContext, id: string, lock?: 'update') {
  let query = executor.select().from(invoices).where(eq(invoices.id, id)).$dynamic()
  if (lock) query = query.for(lock)
  const [row] = UUID.test(id) ? await query : []
  return requireRecord(ctx, row, 'Invoice')
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/** Every rate the society has set, newest first. Old rates stay: an invoice names the one it used. */
export async function listRates(ctx: AuthContext, societyId: string) {
  await loadSociety(db, ctx, societyId)
  const rows = await db
    .select()
    .from(billingRates)
    .where(eq(billingRates.societyId, societyId))
    .orderBy(desc(billingRates.effectiveFrom))
  return rows.map(serializeRate)
}

const serializeRate = (rate: typeof billingRates.$inferSelect) => ({
  ...rate,
  rate: amount(rate.rate),
  sinkingFund: amount(rate.sinkingFund),
  parkingCharge: amount(rate.parkingCharge),
  lateFeePerDay: rate.lateFeePerDay === null ? null : amount(rate.lateFeePerDay),
})

/** The rate in force on a date: the newest one that had already taken effect. */
async function rateOn(tx: DbExecutor, societyId: string, date: string) {
  const [row] = await tx
    .select()
    .from(billingRates)
    .where(and(eq(billingRates.societyId, societyId), lte(billingRates.effectiveFrom, date)))
    .orderBy(desc(billingRates.effectiveFrom))
    .limit(1)
  return row
}

/** Sets the rates from a date. A change inserts a new row, so bills already generated keep theirs. */
export function setRates(ctx: AuthContext, societyId: string, body: SetRatesBody) {
  return db.transaction(async (tx) => {
    await loadSociety(tx, ctx, societyId)
    try {
      const [created] = await tx
        .insert(billingRates)
        .values({
          societyId,
          chargeBasis: body.chargeBasis,
          rate: asAmount(toPaise(body.rate)),
          sinkingFund: asAmount(toPaise(body.sinkingFund ?? 0)),
          parkingCharge: asAmount(toPaise(body.parkingCharge ?? 0)),
          lateFeePerDay: body.lateFeePerDay == null ? null : asAmount(toPaise(body.lateFeePerDay)),
          effectiveFrom: body.effectiveFrom,
          createdBy: ctx.userId,
        })
        .returning()
      await audit(tx, ctx, 'BILLING_RATE_SET', {
        societyId,
        rateId: created!.id,
        effectiveFrom: body.effectiveFrom,
      })
      return serializeRate(created!)
    } catch (error) {
      const code =
        (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code
      if (code === '23505') throw new AppError(409, 'ALREADY_EXISTS', 'Rates are already set from this date')
      throw error
    }
  })
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

const firstOfMonth = (period: string) => `${period}-01`

/**
 * Maintenance is billed by the quarter, starting on 1 January, April, July or October.
 *
 * A quarter is the unit the society's own books use, and the rate on the quarter's first day is
 * the one the whole quarter is charged at: a mid-quarter rate change reaches the next bill, never
 * one already issued.
 */
export const QUARTER_MONTHS = [1, 4, 7, 10] as const

export const isQuarterStart = (period: string) => QUARTER_MONTHS.includes(Number(period.slice(5, 7)) as 1 | 4 | 7 | 10)

/** Fifteen calendar days after the quarter starts, e.g. 1 April is due on 16 April. */
function dueDate(period: string) {
  const start = new Date(`${firstOfMonth(period)}T00:00:00.000Z`)
  start.setUTCDate(start.getUTCDate() + 15)
  return start.toISOString().slice(0, 10)
}

interface BillableFlat {
  id: string
  number: string
  blockName: string
  carpetAreaSqft: number | null
  parkingSlotCount: number | null
  occupants: number
}

/** Active flats with what the charge is worked out from, and whether anyone lives there today. */
async function billableFlats(tx: DbExecutor, societyId: string): Promise<BillableFlat[]> {
  const occupants = tx
    .select({
      flatId: flatResidents.flatId,
      occupants: sql<number>`count(*)`.as('occupants'),
    })
    .from(flatResidents)
    .where(
      and(
        eq(flatResidents.verificationStatus, 'VERIFIED'),
        lte(flatResidents.startDate, sql`current_date`),
        or(isNull(flatResidents.endDate), sql`${flatResidents.endDate} >= current_date`),
      ),
    )
    .groupBy(flatResidents.flatId)
    .as('occupants')

  const rows = await tx
    .select({
      id: flats.id,
      number: flats.number,
      blockName: blocks.name,
      carpetAreaSqft: flats.carpetAreaSqft,
      parkingSlotCount: flats.parkingSlotCount,
      occupants: occupants.occupants,
    })
    .from(flats)
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .leftJoin(occupants, eq(occupants.flatId, flats.id))
    .where(and(eq(blocks.societyId, societyId), eq(flats.status, 'ACTIVE')))
    .orderBy(asc(blocks.name), asc(flats.number))

  return rows.map((row) => ({ ...row, occupants: Number(row.occupants ?? 0) }))
}

interface InvoiceLine {
  flatId: string
  flat: string
  maintenance: number
  sinkingFund: number
  parkingCharge: number
  oneTimeAmount: number
  total: number
}

/**
 * What each flat would be billed for a month, and which flats cannot be billed yet. Per sq ft
 * needs a carpet area on the flat, so a flat without one is listed rather than silently billed at
 * zero.
 */
async function priceInvoices(tx: DbExecutor, societyId: string, body: GenerateInvoicesBody) {
  assertState(isQuarterStart(body.period), 'Maintenance is billed by the quarter: choose January, April, July or October')
  const period = firstOfMonth(body.period)
  const rate = await rateOn(tx, societyId, period)
  assertState(rate !== undefined, 'Set the maintenance rates before generating invoices')

  const all = await billableFlats(tx, societyId)
  const wanted = body.flats === 'ALL' ? all : all.filter((flat) => flat.occupants > 0)
  const already = wanted.length
    ? await tx
        .select({ flatId: invoices.flatId })
        .from(invoices)
        .where(
          and(
            eq(invoices.period, period),
            inArray(
              invoices.flatId,
              wanted.map((flat) => flat.id),
            ),
          ),
        )
    : []
  const invoiced = new Set(already.map((row) => row.flatId))

  const lines: InvoiceLine[] = []
  const skipped: { flat: string; reason: string }[] = []
  const oneTime = toPaise(body.oneTimeAmount ?? 0)

  for (const flat of wanted) {
    const name = `${flat.blockName}-${flat.number}`
    if (invoiced.has(flat.id)) {
      skipped.push({ flat: name, reason: 'Already invoiced for this quarter' })
      continue
    }
    if (rate!.chargeBasis === 'PER_SQFT' && !flat.carpetAreaSqft) {
      skipped.push({ flat: name, reason: 'No carpet area on the flat' })
      continue
    }
    const maintenance =
      rate!.chargeBasis === 'PER_SQFT' ? toPaise(amount(rate!.rate)) * flat.carpetAreaSqft! : toPaise(amount(rate!.rate))
    const parking = toPaise(amount(rate!.parkingCharge)) * (flat.parkingSlotCount ?? 0)
    const sinking = toPaise(amount(rate!.sinkingFund))
    lines.push({
      flatId: flat.id,
      flat: name,
      maintenance: fromPaise(maintenance),
      sinkingFund: fromPaise(sinking),
      parkingCharge: fromPaise(parking),
      oneTimeAmount: fromPaise(oneTime),
      total: fromPaise(maintenance + sinking + parking + oneTime),
    })
  }

  return {
    rate: serializeRate(rate!),
    period,
    dueDate: dueDate(body.period),
    lines,
    skipped,
  }
}

/** The Preview button: the same arithmetic as Generate, writing nothing. */
export async function previewInvoices(ctx: AuthContext, societyId: string, body: GenerateInvoicesBody) {
  await loadSociety(db, ctx, societyId)
  const priced = await priceInvoices(db, societyId, body)
  return {
    ...priced,
    total: priced.lines.reduce((sum, line) => sum + line.total, 0),
  }
}

export function generateInvoices(ctx: AuthContext, societyId: string, body: GenerateInvoicesBody) {
  return db.transaction(async (tx) => {
    await loadSociety(tx, ctx, societyId)
    const priced = await priceInvoices(tx, societyId, body)
    assertState(priced.lines.length > 0, 'There is nothing to invoice for this quarter')

    const created = await tx
      .insert(invoices)
      .values(
        priced.lines.map((line) => ({
          societyId,
          flatId: line.flatId,
          period: priced.period,
          rateId: priced.rate.id,
          maintenance: line.maintenance.toFixed(2),
          sinkingFund: line.sinkingFund.toFixed(2),
          parkingCharge: line.parkingCharge.toFixed(2),
          ...(body.oneTimeAmount
            ? {
                oneTimeDescription: body.oneTimeDescription ?? null,
                oneTimeAmount: body.oneTimeAmount.toFixed(2),
              }
            : {}),
          dueDate: priced.dueDate,
          createdBy: ctx.userId,
        })),
      )
      // A flat already invoiced for the quarter keeps the invoice it has
      .onConflictDoNothing({ target: [invoices.flatId, invoices.period] })
      .returning()

    await audit(tx, ctx, 'INVOICES_GENERATED', {
      societyId,
      period: priced.period,
      generated: created.length,
      skipped: priced.skipped.length,
      oneTime: body.oneTimeDescription ?? null,
    })
    return {
      period: priced.period,
      dueDate: priced.dueDate,
      generated: created.length,
      skipped: priced.skipped,
    }
  })
}

/** The invoices of one society, newest period first, with what has been paid against each. */
export async function listInvoices(ctx: AuthContext, societyId: string, query: ListInvoicesQuery) {
  await loadSociety(db, ctx, societyId)
  const paid = db
    .select({
      invoiceId: payments.invoiceId,
      paid: sum(payments.amount).as('paid'),
    })
    .from(payments)
    .where(isNull(payments.reversedAt))
    .groupBy(payments.invoiceId)
    .as('paid')

  const rows = await db
    .select({
      invoice: invoices,
      flatNumber: flats.number,
      blockName: blocks.name,
      floorLabel: floors.floorLabel,
      paid: paid.paid,
    })
    .from(invoices)
    .innerJoin(flats, eq(flats.id, invoices.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(floors, eq(floors.id, flats.floorId))
    .leftJoin(paid, eq(paid.invoiceId, invoices.id))
    .where(
      and(
        eq(invoices.societyId, societyId),
        ...[
          query.period ? eq(invoices.period, firstOfMonth(query.period)) : undefined,
          query.flatId ? eq(invoices.flatId, query.flatId) : undefined,
          query.status ? eq(invoices.status, query.status) : undefined,
        ].filter((condition): condition is Exclude<typeof condition, undefined> => condition !== undefined),
      ),
    )
    .orderBy(desc(invoices.period), asc(blocks.name), asc(flats.number))

  return rows.map((row) => serializeInvoice(row.invoice, row, amount(row.paid)))
}

function serializeInvoice(
  invoice: typeof invoices.$inferSelect,
  place: { flatNumber: string; blockName: string; floorLabel?: string },
  paid: number,
) {
  const total = amount(invoice.total)
  return {
    ...invoice,
    maintenance: amount(invoice.maintenance),
    sinkingFund: amount(invoice.sinkingFund),
    parkingCharge: amount(invoice.parkingCharge),
    oneTimeAmount: amount(invoice.oneTimeAmount),
    total,
    paid,
    outstanding: Number((total - paid).toFixed(2)),
    flat: {
      id: invoice.flatId,
      number: place.flatNumber,
      blockName: place.blockName,
      floorLabel: place.floorLabel,
    },
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/** Non-reversed payments against an invoice, in paise. */
async function paidPaise(tx: DbExecutor, invoiceId: string) {
  const [row] = await tx
    .select({ paid: sum(payments.amount) })
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), isNull(payments.reversedAt)))
  return toPaise(amount(row?.paid ?? null))
}

/**
 * The status always follows the money received, so it can never disagree with the payments.
 *
 * Settlement is all or nothing, so an invoice is PAID or it is not. One that is short again after
 * a reversal goes back to UNPAID, and the nightly job calls it OVERDUE once the date has passed.
 */
async function settleInvoice(tx: DbExecutor, invoiceId: string, totalPaise: number) {
  const paid = await paidPaise(tx, invoiceId)
  const status = paid >= totalPaise ? 'PAID' : 'UNPAID'
  await tx.update(invoices).set({ status, updatedAt: new Date() }).where(eq(invoices.id, invoiceId))
  return {
    status,
    paid: fromPaise(paid),
    outstanding: fromPaise(Math.max(0, totalPaise - paid)),
  }
}

/**
 * Records money received against an invoice and issues the receipt number the resident sees. The
 * number comes from the database, so two admins recording at the same moment cannot share one.
 */
export function recordPayment(ctx: AuthContext, invoiceId: string, body: RecordPaymentBody) {
  return db.transaction(async (tx) => {
    const invoice = await loadInvoice(tx, ctx, invoiceId, 'update')
    const settlement = await settleInFull(tx, invoice, {
      amountPaise: toPaise(body.amount),
      receivedOn: body.receivedOn,
      paidBy: body.paidBy ?? null,
      note: body.note ?? null,
      recordedBy: ctx.userId,
    })
    await audit(tx, ctx, 'PAYMENT_RECORDED', {
      societyId: invoice.societyId,
      invoiceId,
      paymentId: settlement.payment.id,
      receiptNumber: settlement.payment.receiptNumber,
      amount: body.amount,
      method: 'CASH',
    })
    return { ...settlement.payment, amount: amount(settlement.payment.amount), invoice: settlement.invoice }
  })
}

export interface Settlement {
  amountPaise: number
  receivedOn: string
  paidBy?: string | null
  note?: string | null
  recordedBy?: string | null
}

/**
 * Settles an invoice with one payment for the whole outstanding amount, and issues its receipt.
 *
 * Partial settlement is not offered: a society's books balance per invoice, and an invoice that
 * is half paid leaves every reminder, report and receipt ambiguous. Cash and a verified gateway
 * webhook both arrive here, so there is one place where an invoice becomes PAID.
 */
export async function settleInFull(
  tx: DbExecutor,
  invoice: { id: string; societyId: string; flatId: string; status: string; total: string | null },
  details: Settlement,
) {
  assertState(invoice.status !== 'CANCELLED', 'This invoice has been cancelled')
  const totalPaise = toPaise(amount(invoice.total))
  const outstanding = totalPaise - (await paidPaise(tx, invoice.id))
  assertState(outstanding > 0, 'This invoice is already paid in full')
  assertState(
    details.amountPaise === outstanding,
    `This invoice is settled in full only: ₹${asAmount(outstanding)} is due`,
  )

  const [payment] = await tx
    .insert(payments)
    .values({
      invoiceId: invoice.id,
      amount: asAmount(details.amountPaise),
      receivedOn: details.receivedOn,
      paidBy: details.paidBy ?? null,
      note: details.note ?? null,
      recordedBy: details.recordedBy ?? null,
    })
    .returning()
  const settled = await settleInvoice(tx, invoice.id, totalPaise)
  await issueReceipt(tx, payment!, invoice.societyId)
  const approver = await effectiveApprover(invoice.flatId)
  if (approver) {
    await enqueueNotification(tx, {
      societyId: invoice.societyId,
      eventType: 'PAYMENT_RECORDED',
      entityType: 'invoice',
      entityId: invoice.id,
      recipientIds: [approver.userId],
      payload: { receiptNumber: payment!.receiptNumber, amount: fromPaise(details.amountPaise) },
    })
  }
  return { payment: payment!, invoice: settled }
}

/**
 * A cash entry is never deleted. Reversing it leaves both the payment and the reversal on the
 * record, and puts the money back on the invoice.
 */
export function reversePayment(ctx: AuthContext, paymentId: string, body: ReversePaymentBody) {
  return db.transaction(async (tx) => {
    const [row] = UUID.test(paymentId)
      ? await tx
          .select({
            payment: payments,
            societyId: invoices.societyId,
            total: invoices.total,
          })
          .from(payments)
          .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
          .where(eq(payments.id, paymentId))
          .for('update', { of: payments })
      : []
    await requireRecord(ctx, row && { societyId: row.societyId }, 'Payment')
    assertState(row!.payment.reversedAt === null, 'This payment has already been reversed')

    const [reversed] = await tx
      .update(payments)
      .set({
        reversedAt: new Date(),
        reversedBy: ctx.userId,
        reversalReason: body.reason,
      })
      .where(eq(payments.id, paymentId))
      .returning()
    const settled = await settleInvoice(tx, row!.payment.invoiceId, toPaise(amount(row!.total)))
    await audit(tx, ctx, 'PAYMENT_REVERSED', {
      societyId: row!.societyId,
      invoiceId: row!.payment.invoiceId,
      paymentId,
      receiptNumber: row!.payment.receiptNumber,
      reason: body.reason,
    })
    return { ...reversed!, amount: amount(reversed!.amount), invoice: settled }
  })
}

/** Receipts against one invoice, including reversed ones: the trail is never edited away. */
export async function listPayments(ctx: AuthContext, invoiceId: string) {
  await loadInvoice(db, ctx, invoiceId)
  const rows = await db
    .select()
    .from(payments)
    .where(eq(payments.invoiceId, invoiceId))
    .orderBy(desc(payments.receivedOn), desc(payments.createdAt))
  return rows.map((row) => ({ ...row, amount: amount(row.amount) }))
}


/**
 * The resident's own bills: every invoice for the flats they hold, with the receipts behind
 * each one, so the Bills page needs a single call.
 */
export async function listMyInvoices(ctx: AuthContext) {
  const mine = await db
    .select({ flatId: flatResidents.flatId })
    .from(flatResidents)
    .where(
      and(
        eq(flatResidents.userId, ctx.userId),
        eq(flatResidents.verificationStatus, 'VERIFIED'),
        lte(flatResidents.startDate, sql`current_date`),
        or(isNull(flatResidents.endDate), gte(flatResidents.endDate, sql`current_date`)),
      ),
    )
  const flatIds = mine.map((row) => row.flatId)
  if (flatIds.length === 0) return []

  const rows = await db
    .select({ invoice: invoices, flatNumber: flats.number, blockName: blocks.name, floorLabel: floors.floorLabel })
    .from(invoices)
    .innerJoin(flats, eq(flats.id, invoices.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(floors, eq(floors.id, flats.floorId))
    .where(inArray(invoices.flatId, flatIds))
    .orderBy(desc(invoices.period))
    .limit(36)

  const received = rows.length
    ? await db
        .select()
        .from(payments)
        .where(inArray(payments.invoiceId, rows.map((row) => row.invoice.id)))
        .orderBy(desc(payments.receivedOn))
    : []

  return rows.map((row) => {
    const mineOnly = received.filter((payment) => payment.invoiceId === row.invoice.id)
    const settled = mineOnly.filter((payment) => payment.reversedAt === null)
    return {
      ...serializeInvoice(row.invoice, row, amount(settled.reduce((total, payment) => total + amount(payment.amount), 0).toFixed(2))),
      payments: mineOnly.map((payment) => ({ ...payment, amount: amount(payment.amount) })),
    }
  })
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * Collections and dues, or occupancy, as rows the panel renders and the CSV download writes.
 * Both are read back from the invoices and assignments themselves; nothing is cached.
 */
export async function runReport(ctx: AuthContext, societyId: string, query: ReportQuery) {
  await loadSociety(db, ctx, societyId)
  if (query.report === 'COLLECTIONS') return collections(societyId, query.period)
  return occupancyReport(societyId)
}

async function collections(societyId: string, period?: string) {
  const paid = db
    .select({
      invoiceId: payments.invoiceId,
      paid: sum(payments.amount).as('paid'),
    })
    .from(payments)
    .where(isNull(payments.reversedAt))
    .groupBy(payments.invoiceId)
    .as('paid')

  const rows = await db
    .select({
      flat: sql<string>`${blocks.name} || '-' || ${flats.number}`,
      period: invoices.period,
      billed: invoices.total,
      paid: paid.paid,
      dueDate: invoices.dueDate,
      status: invoices.status,
    })
    .from(invoices)
    .innerJoin(flats, eq(flats.id, invoices.flatId))
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .leftJoin(paid, eq(paid.invoiceId, invoices.id))
    .where(and(eq(invoices.societyId, societyId), ...(period ? [eq(invoices.period, firstOfMonth(period))] : [])))
    .orderBy(desc(invoices.period), asc(blocks.name), asc(flats.number))

  const lines = rows.map((row) => ({
    flat: row.flat,
    period: row.period,
    billed: amount(row.billed),
    paid: amount(row.paid),
    outstanding: Number((amount(row.billed) - amount(row.paid)).toFixed(2)),
    dueDate: row.dueDate,
    status: row.status,
  }))
  return {
    report: 'COLLECTIONS' as const,
    columns: ['flat', 'period', 'billed', 'paid', 'outstanding', 'dueDate', 'status'],
    rows: lines,
    totals: {
      billed: Number(lines.reduce((total, line) => total + line.billed, 0).toFixed(2)),
      paid: Number(lines.reduce((total, line) => total + line.paid, 0).toFixed(2)),
      outstanding: Number(lines.reduce((total, line) => total + line.outstanding, 0).toFixed(2)),
    },
  }
}

async function occupancyReport(societyId: string) {
  const rows = await db
    .select({
      flat: sql<string>`${blocks.name} || '-' || ${flats.number}`,
      floor: floors.floorLabel,
      flatType: flats.flatType,
      carpetAreaSqft: flats.carpetAreaSqft,
      status: flats.status,
      owners: sql<number>`count(*) filter (where ${flatResidents.residentType} = 'OWNER' and ${flatResidents.verificationStatus} = 'VERIFIED')`,
      tenants: sql<number>`count(*) filter (where ${flatResidents.residentType} = 'TENANT' and ${flatResidents.verificationStatus} = 'VERIFIED')`,
    })
    .from(flats)
    .innerJoin(blocks, eq(blocks.id, flats.blockId))
    .innerJoin(floors, eq(floors.id, flats.floorId))
    .leftJoin(
      flatResidents,
      and(
        eq(flatResidents.flatId, flats.id),
        lte(flatResidents.startDate, sql`current_date`),
        or(isNull(flatResidents.endDate), sql`${flatResidents.endDate} >= current_date`),
      ),
    )
    .where(eq(blocks.societyId, societyId))
    .groupBy(blocks.name, flats.number, floors.floorLabel, flats.flatType, flats.carpetAreaSqft, flats.status)
    .orderBy(asc(blocks.name), asc(flats.number))

  const lines = rows.map((row) => ({
    ...row,
    owners: Number(row.owners),
    tenants: Number(row.tenants),
    occupancy: Number(row.owners) + Number(row.tenants) === 0 ? 'VACANT' : Number(row.owners) > 0 ? 'OWNER_OCCUPIED' : 'RENTED',
  }))
  return {
    report: 'OCCUPANCY' as const,
    columns: ['flat', 'floor', 'flatType', 'carpetAreaSqft', 'owners', 'tenants', 'occupancy', 'status'],
    rows: lines,
    totals: {
      flats: lines.length,
      vacant: lines.filter((line) => line.occupancy === 'VACANT').length,
      rented: lines.filter((line) => line.occupancy === 'RENTED').length,
    },
  }
}

/** The Download CSV button. Quotes every field, so a flat label with a comma survives the trip. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]) {
  const cell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
  return [columns.map(cell).join(','), ...rows.map((row) => columns.map((column) => cell(row[column])).join(','))].join('\n')
}
