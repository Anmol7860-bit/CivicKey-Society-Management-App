import { ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import { listSocieties } from '../society/api'
import { listAuditLogs, type AuditEntry } from './api'
import { Panel } from '../society/parts'
import { useResource } from '../society/useResource'

/** The events worth filtering by, grouped as the Admin thinks of them. */
const EVENTS = [
  'AUTHORIZATION_DENIED',
  'AUTH_LOGIN_SUCCESS',
  'AUTH_LOGIN_FAILED',
  'COMMITTEE_MEMBERSHIP_SET',
  'SOCIETY_UPDATED',
  'BLOCK_CREATED',
  'FLOOR_CREATED',
  'FLAT_CREATED',
  'FLAT_UPDATED',
  'GATE_CREATED',
  'RESIDENT_REGISTERED',
  'RESIDENT_VERIFIED',
  'RESIDENT_REJECTED',
  'STAFF_REGISTERED',
  'STAFF_UPDATED',
  'BILLING_RATE_SET',
  'INVOICES_GENERATED',
  'PAYMENT_RECORDED',
  'PAYMENT_REVERSED',
]

/** The parts of an event's metadata worth reading at a glance; ids are left out. */
const DETAIL_KEYS = ['code', 'permission', 'path', 'name', 'reason', 'period', 'generated', 'amount', 'receiptNumber', 'kind', 'changes']

function details(entry: AuditEntry) {
  return DETAIL_KEYS.filter((key) => entry.metadata[key] !== undefined && entry.metadata[key] !== null)
    .map((key) => {
      const value = entry.metadata[key]
      return typeof value === 'object' ? `${key}: ${JSON.stringify(value)}` : `${value}`
    })
    .join(' · ')
}

/** Security activity: who did what, read straight from the audit trail. Nothing here is editable. */
export function SecurityPage({ accessToken }: { accessToken: string }) {
  const { t } = useTranslation()
  const [filters, setFilters] = useState({ event: '', user: '' })

  const societies = useResource(() => listSocieties(accessToken), [accessToken])
  const societyId = societies.data?.[0]?.id
  const logs = useResource(
    societyId
      ? () =>
          listAuditLogs(accessToken, societyId, {
            ...(filters.event ? { event: filters.event } : {}),
            ...(filters.user ? { user: filters.user } : {}),
          })
      : null,
    [accessToken, societyId, filters.event, filters.user],
  )

  if (societies.loading) return <Skeleton rows={4} />
  if (societies.error) return <ErrorState message={societies.error} onRetry={societies.reload} />

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.admin.nav.security')}</h1>
        <p className="text-[13px] text-muted">{t('area.admin.security.intro')}</p>
      </header>

      <Panel title={t('area.admin.security.title')} description={t('area.admin.security.permission')}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            id="audit-event"
            label={t('area.admin.security.event')}
            options={EVENTS.map((value) => ({ value, label: t(`area.admin.security.events.${value}`, { defaultValue: value }) }))}
            placeholder={t('area.admin.security.allEvents')}
            value={filters.event}
            onChange={(event) => setFilters({ ...filters, event: event.target.value })}
          />
          <TextField
            id="audit-user"
            label={t('area.admin.security.user')}
            value={filters.user}
            onChange={(event) => setFilters({ ...filters, user: event.target.value })}
            placeholder={t('area.admin.security.userPlaceholder')}
            maxLength={60}
          />
        </div>

        {logs.loading ? (
          <Skeleton rows={5} />
        ) : logs.error ? (
          <ErrorState message={logs.error} onRetry={logs.reload} />
        ) : logs.data?.length ? (
          <div className="overflow-auto rounded-xl border border-line">
            <table className="w-full border-collapse">
              <thead className="bg-canvas">
                <tr>
                  {['when', 'who', 'event', 'details'].map((column) => (
                    <th key={column} className="px-3 py-2 text-left text-[11px] font-bold tracking-wide text-muted uppercase">
                      {t(`area.admin.security.columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.data.map((entry) => (
                  <tr key={entry.id} className="border-t border-line">
                    <td className="px-3 py-2 text-[12px] whitespace-nowrap text-muted">
                      {new Date(entry.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                    </td>
                    <td className="px-3 py-2 text-[13px] font-semibold text-ink">
                      {entry.actor?.name ?? t('area.admin.security.unknownActor')}
                    </td>
                    <td className="px-3 py-2 text-[13px] text-ink-soft">
                      {t(`area.admin.security.events.${entry.eventType}`, { defaultValue: entry.eventType })}
                    </td>
                    <td className="px-3 py-2 text-[12px] text-muted">{details(entry)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={ShieldCheck} title={t('area.admin.security.empty.title')} description={t('area.admin.security.empty.description')} />
        )}
      </Panel>
    </div>
  )
}
