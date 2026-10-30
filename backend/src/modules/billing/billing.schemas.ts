import { z } from 'zod'
import { chargeBasis } from '../../db/schema.js'

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
/** The month billed, as YYYY-MM; the database stores its first day */
const period = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM')

/** A quarter, named by the month it starts in. Maintenance is billed four times a year. */
const quarter = period.regex(/-(01|04|07|10)$/, 'Choose a quarter start: January, April, July or October')
/** Rupees, to the paisa. Sent as a number and stored as numeric, never as a float in the database. */
const money = (max = 1_000_000) =>
  z
    .number()
    .min(0)
    .max(max)
    .refine((value) => Number.isFinite(value) && Math.round(value * 100) === value * 100, {
      message: 'Give an amount in rupees and paise',
    })

export const setRatesSchema = z.strictObject({
  chargeBasis: z.enum(chargeBasis.enumValues),
  /** Per sq ft of carpet area, or per flat, depending on the basis */
  rate: money().refine((value) => value > 0, {
    message: 'The rate must be more than zero',
  }),
  sinkingFund: money().optional(),
  parkingCharge: money().optional(),
  lateFeePerDay: money(10_000).nullable().optional(),
  effectiveFrom: isoDate,
})

export const generateInvoicesSchema = z
  .strictObject({
    period: quarter,
    /** Which flats to bill: every occupied flat, or every active flat including the empty ones */
    flats: z.enum(['OCCUPIED', 'ALL']).optional(),
    oneTimeDescription: z.string().trim().min(2).max(120).optional(),
    oneTimeAmount: money().optional(),
  })
  .refine((body) => !body.oneTimeAmount || body.oneTimeDescription !== undefined, {
    message: 'Describe what the one-time charge is for',
    path: ['oneTimeDescription'],
  })

export const listInvoicesSchema = z.strictObject({
  period: period.optional(),
  flatId: z.uuid().optional(),
  status: z.enum(['UNPAID', 'OVERDUE', 'PARTIALLY_PAID', 'PAID', 'CANCELLED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  // ponytail: no default cap, so the existing panel keeps listing a whole society; give it a
  // pager and a default limit when one society's invoices outgrow a single screen.
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

export const recordPaymentSchema = z.strictObject({
  amount: money().refine((value) => value > 0, {
    message: 'The amount must be more than zero',
  }),
  receivedOn: isoDate,
  paidBy: z.string().trim().min(2).max(120).optional(),
  note: z.string().trim().min(1).max(200).optional(),
})

export const reversePaymentSchema = z.strictObject({
  reason: z.string().trim().min(3, 'Give a reason').max(200),
})

/** The only reports there are. A request for anything else is answered 422, not 400. */
export const REPORT_TYPES = ['COLLECTIONS', 'OCCUPANCY'] as const

/** The reports panel: what to report on, and over which period */
export const reportSchema = z.strictObject({
  report: z.enum(REPORT_TYPES),
  period: period.optional(),
  format: z.enum(['json', 'csv']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  /** Left out, the whole report comes back; the CSV download always takes every row */
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

export type SetRatesBody = z.infer<typeof setRatesSchema>
export type GenerateInvoicesBody = z.infer<typeof generateInvoicesSchema>
export type ListInvoicesQuery = z.infer<typeof listInvoicesSchema>
export type RecordPaymentBody = z.infer<typeof recordPaymentSchema>
export type ReversePaymentBody = z.infer<typeof reversePaymentSchema>
export type ReportQuery = z.infer<typeof reportSchema>
