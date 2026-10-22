import { send } from '../auth/api'
import { call } from '../society/api'

export type ChargeBasis = 'PER_SQFT' | 'PER_FLAT'
export type InvoiceStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED'
export type ReportName = 'COLLECTIONS' | 'OCCUPANCY'

export interface BillingRate {
  id: string
  societyId: string
  chargeBasis: ChargeBasis
  rate: number
  sinkingFund: number
  parkingCharge: number
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
  dueDay: number
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
