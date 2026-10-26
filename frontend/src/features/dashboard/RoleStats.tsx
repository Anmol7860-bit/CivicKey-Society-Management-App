import { useTranslation } from 'react-i18next'
import type { AuthUser } from '../auth/api'
import { listMyInvoices } from '../billing/api'
import { gateSummary, listMyPasses, listMyVisits } from '../gate/api'
import { useResource } from '../society/useResource'

const rupees = (value: number) => `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

/** The guard's three cards, read from the gate itself. */
export function useGuardSummary(user: AuthUser, accessToken: string) {
  const enabled = user.role === 'GUARD' && Boolean(user.societyId)
  return useResource(enabled ? () => gateSummary(accessToken, user.societyId!) : null, [accessToken, user.societyId, enabled])
}

/** The resident's three cards: who is waiting, what is pre-approved, and what is owed. */
export function useResidentSummary(user: AuthUser, accessToken: string) {
  const enabled = user.permissions.includes('VISIT_VIEW_OWN')
  const visits = useResource(enabled ? () => listMyVisits(accessToken) : null, [accessToken, enabled])
  const passes = useResource(enabled ? () => listMyPasses(accessToken) : null, [accessToken, enabled])
  const invoices = useResource(
    user.permissions.includes('BILL_VIEW_OWN') ? () => listMyInvoices(accessToken) : null,
    [accessToken, user.permissions.length],
  )
  return { visits, passes, invoices }
}

export type GuardSummary = ReturnType<typeof useGuardSummary>
export type ResidentSummary = ReturnType<typeof useResidentSummary>

/** One headline on a card, or a dash until its call has answered. */
function Value({ value, hint }: { value?: string; hint?: string }) {
  const { t } = useTranslation()
  if (!value) {
    return (
      <>
        <p className="text-lg text-ink">—</p>
        <p className="text-[10px] text-muted">{t('shell.noData')}</p>
      </>
    )
  }
  return (
    <>
      <p className="text-lg text-ink">{value}</p>
      {hint && <p className="text-[10px] text-muted">{hint}</p>}
    </>
  )
}

export function GuardStat({ statKey, summary }: { statKey: string; summary: GuardSummary }) {
  const { t } = useTranslation()
  const data = summary.data
  if (!data) return <Value />

  if (statKey === 'expected') return <Value value={String(data.expected)} hint={t('area.guard.stats.expectedHint', { count: data.today })} />
  if (statKey === 'onSite')
    return (
      <Value
        value={String(data.inside)}
        hint={t('area.guard.stats.onSiteHint', { visitors: data.visitorsInside, staff: data.staffInside })}
      />
    )
  return <Value />
}

export function ResidentStat({ statKey, summary }: { statKey: string; summary: ResidentSummary }) {
  const { t } = useTranslation()
  const { visits, passes, invoices } = summary

  if (statKey === 'awaiting') {
    if (!visits.data) return <Value />
    const waiting = visits.data.filter((visit) => visit.status === 'AWAITING_APPROVAL')
    return (
      <Value
        value={String(waiting.length)}
        hint={waiting[0] ? t('area.resident.stats.awaitingHint', { name: waiting[0].visitorName }) : t('area.resident.stats.noneWaiting')}
      />
    )
  }
  if (statKey === 'passes') {
    if (!passes.data) return <Value />
    const active = passes.data.filter((pass) => pass.status === 'ACTIVE')
    return <Value value={String(active.length)} hint={active[0] ? active[0].entryCode : t('area.resident.stats.noPasses')} />
  }
  if (statKey === 'bills') {
    if (!invoices.data) return <Value />
    const owed = invoices.data.reduce((total, invoice) => total + (invoice.status === 'CANCELLED' ? 0 : invoice.outstanding), 0)
    const due = invoices.data.find((invoice) => invoice.outstanding > 0)
    return <Value value={rupees(owed)} hint={due ? t('area.resident.stats.dueBy', { date: due.dueDate }) : t('area.resident.stats.allPaid')} />
  }
  return <Value />
}
