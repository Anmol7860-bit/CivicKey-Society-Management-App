import type { Tone } from '../../components/ui/Badge'
import { listMyInvoices, type MyInvoice } from '../billing/api'
import { listMyAccessRequests, listMyPasses, listMyVisits, type AccessRequest, type Visit, type VisitorPass } from '../gate/api'
import { useResource } from '../society/useResource'

export type FeedKind = 'VISIT' | 'PASS' | 'BILL' | 'REQUEST'

export interface FeedEvent {
  id: string
  kind: FeedKind
  /** ISO timestamp the event happened at; date-only values are placed at midday */
  at: string
  /** Key under area.resident.activity.events */
  event: string
  values: Record<string, string | number>
  tone: Tone
  /** Still waiting on the resident, so it belongs on Notifications */
  pending?: boolean
  /** Where the resident goes to deal with it, relative to their area */
  to?: string
}

/** Dates arrive as YYYY-MM-DD; midday keeps them beside the same day's timestamps. */
const at = (value: string) => (value.length === 10 ? `${value}T12:00:00.000Z` : value)

const PURPOSE_TONE: Record<string, Tone> = {
  APPROVED: 'positive',
  INSIDE: 'brand',
  LEFT: 'neutral',
  DENIED: 'danger',
  LEAVE_AT_GATE: 'warning',
}

function visitEvents(visits: Visit[]): FeedEvent[] {
  return visits.map((visit) => {
    const values = { name: visit.visitorName, flat: visit.flat.label }
    if (visit.status === 'WAITING') {
      return { id: `visit-${visit.id}`, kind: 'VISIT', at: visit.createdAt, event: 'visitWaiting', values, tone: 'warning', pending: true, to: 'visitor-approval' }
    }
    if (visit.status === 'INSIDE') {
      return { id: `visit-${visit.id}`, kind: 'VISIT', at: visit.enteredAt ?? visit.createdAt, event: 'visitInside', values, tone: 'brand' }
    }
    if (visit.status === 'LEFT') {
      return { id: `visit-${visit.id}`, kind: 'VISIT', at: visit.exitedAt ?? visit.createdAt, event: 'visitLeft', values, tone: 'neutral' }
    }
    return {
      id: `visit-${visit.id}`,
      kind: 'VISIT',
      at: visit.decidedAt ?? visit.createdAt,
      event: `visit${visit.status === 'APPROVED' ? 'Approved' : visit.status === 'DENIED' ? 'Denied' : 'LeftAtGate'}`,
      values,
      tone: PURPOSE_TONE[visit.status] ?? 'neutral',
    }
  })
}

function passEvents(passes: VisitorPass[]): FeedEvent[] {
  return passes.map((pass) => {
    const values = { name: pass.visitorName, code: pass.entryCode, date: pass.validOn }
    if (pass.status === 'USED') {
      return { id: `pass-${pass.id}`, kind: 'PASS', at: pass.usedAt ?? pass.createdAt, event: 'passUsed', values, tone: 'positive' }
    }
    if (pass.status === 'CANCELLED') {
      return { id: `pass-${pass.id}`, kind: 'PASS', at: pass.createdAt, event: 'passCancelled', values, tone: 'neutral' }
    }
    return { id: `pass-${pass.id}`, kind: 'PASS', at: pass.createdAt, event: 'passCreated', values, tone: 'brand', to: 'visitor-passes' }
  })
}

function billEvents(invoices: MyInvoice[]): FeedEvent[] {
  const events: FeedEvent[] = []
  for (const invoice of invoices) {
    const month = new Date(invoice.period).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    const owed = invoice.status === 'UNPAID' || invoice.status === 'PARTIALLY_PAID'
    events.push({
      id: `bill-${invoice.id}`,
      kind: 'BILL',
      at: at(invoice.dueDate),
      event: owed ? 'billDue' : 'billIssued',
      values: { month, amount: owed ? invoice.outstanding : invoice.total, date: invoice.dueDate },
      tone: owed ? 'warning' : 'neutral',
      ...(owed ? { pending: true, to: 'bills' } : {}),
    })
    for (const payment of invoice.payments) {
      events.push(
        payment.reversedAt
          ? {
              id: `payment-${payment.id}`,
              kind: 'BILL',
              at: payment.reversedAt,
              event: 'billReversed',
              values: { amount: payment.amount, receipt: payment.receiptNumber },
              tone: 'danger',
            }
          : {
              id: `payment-${payment.id}`,
              kind: 'BILL',
              at: at(payment.receivedOn),
              event: 'billPaid',
              values: { amount: payment.amount, receipt: payment.receiptNumber },
              tone: 'positive',
            },
      )
    }
  }
  return events
}

function requestEvents(requests: AccessRequest[]): FeedEvent[] {
  return requests.map((request) => {
    const values = { name: request.name, kind: request.kind }
    if (request.status === 'PENDING') {
      return { id: `request-${request.id}`, kind: 'REQUEST', at: request.createdAt, event: 'requestPending', values, tone: 'warning' }
    }
    return {
      id: `request-${request.id}`,
      kind: 'REQUEST',
      at: request.decidedAt ?? request.createdAt,
      event: request.status === 'APPROVED' ? 'requestApproved' : 'requestRejected',
      values: { ...values, reason: request.decisionReason ?? '' },
      tone: request.status === 'APPROVED' ? 'positive' : 'danger',
    }
  })
}

/** The same events, from data a caller has already loaded. */
export function buildEvents(parts: {
  visits?: Visit[]
  passes?: VisitorPass[]
  invoices?: MyInvoice[]
  requests?: AccessRequest[]
}): FeedEvent[] {
  return [
    ...visitEvents(parts.visits ?? []),
    ...passEvents(parts.passes ?? []),
    ...billEvents(parts.invoices ?? []),
    ...requestEvents(parts.requests ?? []),
  ].sort((a, b) => b.at.localeCompare(a.at))
}

/**
 * Everything that has happened on the resident's own flat, newest first, built from the records
 * each screen already shows. Nothing new is stored: Activity and Notifications are two readings
 * of the same list, so a visitor approved on one screen is accounted for on both.
 *
 * ponytail: vehicles are left out - they have no lifecycle worth a timeline entry, and My flat
 * lists them. Add them here if "who added this car" ever needs answering.
 */
export function useFeed(accessToken: string) {
  const visits = useResource(() => listMyVisits(accessToken), [accessToken])
  const passes = useResource(() => listMyPasses(accessToken), [accessToken])
  const invoices = useResource(() => listMyInvoices(accessToken), [accessToken])
  const requests = useResource(() => listMyAccessRequests(accessToken), [accessToken])
  const parts = [visits, passes, invoices, requests]

  const events = buildEvents({ visits: visits.data, passes: passes.data, invoices: invoices.data, requests: requests.data })

  return {
    events,
    loading: parts.some((part) => part.loading),
    // One failure is enough to make the timeline wrong, so it is shown rather than hidden
    error: parts.find((part) => part.error)?.error,
    reload: () => parts.forEach((part) => part.reload()),
  }
}
