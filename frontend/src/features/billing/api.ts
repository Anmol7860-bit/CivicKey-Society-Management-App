import { send } from '../auth/api'
import { call } from '../society/api'

export type ChargeBasis = 'PER_SQFT' | 'PER_FLAT'
export type InvoiceStatus = 'UNPAID' | 'OVERDUE' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED'
export type ReportName = 'COLLECTIONS' | 'OCCUPANCY'

export interface BillingRate {
  id: string
  societyId: string
  chargeBasis: ChargeBasis
  rate: number
  sinkingFund: number
  parkingCharge: number
  /** Still returned for rates already set; a bill is due fifteen days after its quarter starts */
  dueDay: number
  lateFeePerDay: number | null
  effectiveFrom: string
  createdAt: string
}

export interface RatesBody {
  chargeBasis: ChargeBasis
  rate: number
  sinkingFund?: number
  parkingCharge?: number
  lateFeePerDay?: number | null
  effectiveFrom: string
}

export interface Invoice {
  id: string
  flatId: string
  period: string
  maintenance: number
  sinkingFund: number
  parkingCharge: number
  oneTimeDescription: string | null
  oneTimeAmount: number
  total: number
  paid: number
  outstanding: number
  dueDate: string
  status: InvoiceStatus
  flat: { id: string; number: string; blockName: string; floorLabel?: string }
}

export interface InvoiceLine {
  flatId: string
  flat: string
  maintenance: number
  sinkingFund: number
  parkingCharge: number
  oneTimeAmount: number
  total: number
}

export interface Preview {
  period: string
  dueDate: string
  rate: BillingRate
  lines: InvoiceLine[]
  /** Flats that could not be priced, and why */
  skipped: { flat: string; reason: string }[]
  total: number
}

export interface Generated {
  period: string
  dueDate: string
  generated: number
  skipped: { flat: string; reason: string }[]
}

export interface GenerateBody {
  period: string
  flats?: 'OCCUPIED' | 'ALL'
  oneTimeDescription?: string
  oneTimeAmount?: number
}

export interface Payment {
  id: string
  invoiceId: string
  amount: number
  receivedOn: string
  paidBy: string | null
  note: string | null
  receiptNumber: string
  reversedAt: string | null
  reversalReason: string | null
  invoice?: { status: InvoiceStatus; paid: number; outstanding: number }
}

export interface Report {
  report: ReportName
  columns: string[]
  rows: Record<string, string | number | null>[]
  totals: Record<string, number>
}

/** One of the resident's own bills, with the receipts behind it */
export interface MyInvoice extends Invoice {
  payments: Payment[]
}

export const listMyInvoices = (token: string) => call<MyInvoice[]>(token, 'GET', '/me/invoices')

export const listRates = (token: string, societyId: string) => call<BillingRate[]>(token, 'GET', `/societies/${societyId}/billing-rates`)
export const setRates = (token: string, societyId: string, body: RatesBody) =>
  call<BillingRate>(token, 'POST', `/societies/${societyId}/billing-rates`, body)

export function listInvoices(token: string, societyId: string, filters: { period?: string; flatId?: string; status?: InvoiceStatus } = {}) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString()
  return call<Invoice[]>(token, 'GET', `/societies/${societyId}/invoices${query ? `?${query}` : ''}`)
}
export const previewInvoices = (token: string, societyId: string, body: GenerateBody) =>
  call<Preview>(token, 'POST', `/societies/${societyId}/invoices/preview`, body)
export const generateInvoices = (token: string, societyId: string, body: GenerateBody) =>
  call<Generated>(token, 'POST', `/societies/${societyId}/invoices`, body)

export const listPayments = (token: string, invoiceId: string) => call<Payment[]>(token, 'GET', `/invoices/${invoiceId}/payments`)
export const recordPayment = (
  token: string,
  invoiceId: string,
  body: { amount: number; receivedOn: string; paidBy?: string; note?: string },
) => call<Payment>(token, 'POST', `/invoices/${invoiceId}/payments`, body)
export const reversePayment = (token: string, paymentId: string, body: { reason: string }) =>
  call<Payment>(token, 'POST', `/payments/${paymentId}/reverse`, body)

export const runReport = (token: string, societyId: string, query: { report: ReportName; period?: string }) =>
  call<Report>(
    token,
    'GET',
    `/societies/${societyId}/reports?${new URLSearchParams({ report: query.report, ...(query.period ? { period: query.period } : {}) })}`,
  )

/**
 * The Download CSV button. The server builds the same rows the panel shows, and the browser is
 * handed a blob so the download does not leave the signed-in page.
 */
export async function downloadReport(token: string, societyId: string, query: { report: ReportName; period?: string }) {
  const search = new URLSearchParams({ report: query.report, format: 'csv', ...(query.period ? { period: query.period } : {}) })
  const response = await fetch(`/api/v1/societies/${societyId}/reports?${search}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    // Let the shared client turn the body into the usual ApiError
    return send(`/api/v1/societies/${societyId}/reports?${search}`, { headers: { Authorization: `Bearer ${token}` } })
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${query.report.toLowerCase()}-${query.period ?? 'all'}.csv`
  link.click()
  URL.revokeObjectURL(url)
  return undefined
}

export interface Checkout {
  attemptId: string
  orderId: string
  amount: number
  currency: string
  keyId: string
}

export interface ReceiptRow {
  id: string
  number: string
  status: 'PENDING_PDF' | 'READY' | 'FAILED'
  amount: string
  receivedOn: string
  createdAt: string
}

/** Asks the server to start a hosted checkout. Nothing is paid until the gateway tells the server. */
export const startCheckout = (token: string, invoiceId: string) =>
  call<Checkout>(token, 'POST', `/invoices/${invoiceId}/checkout`, {})

export type PaymentState = 'INITIATING' | 'CREATED' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'REVIEW_REQUIRED'

/** What the server has verified about a checkout attempt. The browser's own return proves nothing. */
export interface PaymentStatus {
  id: string
  invoiceId: string
  status: PaymentState
  amount: number
  currency: string
  orderId: string | null
  providerPaymentId: string | null
  failureReason: string | null
  invoiceStatus: InvoiceStatus
}

export const paymentStatus = (token: string, paymentId: string) => call<PaymentStatus>(token, 'GET', `/payments/${paymentId}`)

export const listReceipts = (token: string, invoiceId: string) =>
  call<ReceiptRow[]>(token, 'GET', `/invoices/${invoiceId}/receipts`)

/** The receipt PDF, fetched with the token and handed to the browser as a blob URL. */
export async function receiptPdfUrl(token: string, receiptId: string) {
  const res = await fetch(`/api/v1/receipts/${receiptId}/pdf`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error('That receipt is not ready yet.')
  return URL.createObjectURL(await res.blob())
}
