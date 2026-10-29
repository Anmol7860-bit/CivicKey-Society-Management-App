import { ArrowLeftRight } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, type Tone } from '../../components/ui/Badge'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import type { AuthUser } from '../auth/api'
import { listVisitorMovements, type VisitMovement, type VisitMovementFilters } from './api'
import { today } from '../../lib/day'
import { FormGrid, Panel, RowButton } from '../society/parts'
import { useResource } from '../society/useResource'

const PAGE = 50
const EVENT_TONE: Record<VisitMovement['eventType'], Tone> = { ENTRY: 'positive', EXIT: 'neutral', ENTRY_REJECTED: 'danger' }
const stamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

/**
 * The office's audit of visitor movement: entries, exits and refusals at the gate, newest first.
 *
 * It reads what the gate recorded and changes nothing. A visit that was approved but never
 * arrived has no movement, so it is not here; an expiry never writes an exit.
 */
export function VisitorMovementPage({ user, accessToken }: { user: AuthUser; accessToken: string }) {
  const { t } = useTranslation()
  const societyId = user.societyId
  const [filters, setFilters] = useState<VisitMovementFilters>({})
  const [shown, setShown] = useState(PAGE)
  const log = useResource(
    societyId ? () => listVisitorMovements(accessToken, societyId, { ...filters, limit: shown }) : null,
    [accessToken, societyId, shown, filters.search, filters.eventType, filters.movementState, filters.dateFrom, filters.dateTo],
  )

  if (!societyId) return <ErrorState message={t('area.guard.noSociety')} />

  const set = (patch: VisitMovementFilters) => {
    setShown(PAGE)
    setFilters((current) => ({ ...current, ...patch }))
  }
  const rows = log.data?.movements ?? []
  const total = log.data?.total ?? 0

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.admin.visitorMovement.title')}</h1>
        <p className="text-[13px] text-muted">{t('area.admin.visitorMovement.intro')}</p>
      </header>

      <Panel title={t('area.admin.visitorMovement.filtersTitle')} description={t('area.admin.visitorMovement.filtersDescription')}>
        <FormGrid>
          <TextField
            id="visitor-movement-search"
            label={t('area.admin.visitorMovement.search')}
            value={filters.search ?? ''}
            onChange={(event) => set({ search: event.target.value || undefined })}
            placeholder={t('area.admin.visitorMovement.searchPlaceholder')}
            maxLength={60}
          />
          <Select
            id="visitor-movement-event"
            label={t('area.admin.visitorMovement.event')}
            options={[
              { value: '', label: t('area.admin.visitorMovement.allEvents') },
              ...(['ENTRY', 'EXIT', 'ENTRY_REJECTED'] as const).map((value) => ({
                value,
                label: t(`area.admin.visitorMovement.events.${value}`),
              })),
            ]}
            value={filters.eventType ?? ''}
            onChange={(event) => set({ eventType: (event.target.value || undefined) as VisitMovementFilters['eventType'] })}
          />
          <Select
            id="visitor-movement-state"
            label={t('area.admin.visitorMovement.state')}
            options={[
              { value: '', label: t('area.admin.visitorMovement.allStates') },
              ...(['INSIDE', 'EXITED', 'ENTRY_REJECTED'] as const).map((value) => ({
                value,
                label: t(`area.admin.visitorMovement.states.${value}`),
              })),
            ]}
            value={filters.movementState ?? ''}
            onChange={(event) => set({ movementState: (event.target.value || undefined) as VisitMovementFilters['movementState'] })}
          />
          <TextField
            id="visitor-movement-from"
            type="date"
            label={t('area.admin.visitorMovement.from')}
            value={filters.dateFrom ?? ''}
            max={today()}
            onChange={(event) => set({ dateFrom: event.target.value || undefined })}
          />
          <TextField
            id="visitor-movement-to"
            type="date"
            label={t('area.admin.visitorMovement.to')}
            value={filters.dateTo ?? ''}
            max={today()}
            onChange={(event) => set({ dateTo: event.target.value || undefined })}
          />
        </FormGrid>
      </Panel>

      <Panel
        title={t('area.admin.visitorMovement.listTitle')}
        description={t('area.admin.visitorMovement.listDescription', { count: total })}
      >
        {log.loading ? (
          <Skeleton rows={4} />
        ) : log.error ? (
          <ErrorState message={log.error} onRetry={log.reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ArrowLeftRight}
            title={t('area.admin.visitorMovement.empty.title')}
            description={t('area.admin.visitorMovement.empty.description')}
          />
        ) : (
          <>
            <div className="overflow-auto rounded-xl border border-line">
              <table className="w-full border-collapse">
                <thead className="bg-canvas">
                  <tr>
                    {['when', 'visitor', 'flat', 'purpose', 'event', 'gate', 'by', 'reason'].map((column) => (
                      <th key={column} className="px-3 py-2 text-left text-[11px] font-bold tracking-wide text-muted uppercase">
                        {t(`area.admin.visitorMovement.columns.${column}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.visitId}-${row.eventType}`} className="border-t border-line">
                      <td className="px-3 py-2 text-[13px] font-semibold text-ink">{stamp(row.at)}</td>
                      <td className="px-3 py-2 text-[13px] text-ink">
                        {row.name}
                        <span className="block text-[11px] text-muted">{row.phone}</span>
                      </td>
                      <td className="px-3 py-2 text-[13px] text-ink-soft">{row.flat}</td>
                      <td className="px-3 py-2 text-[13px] text-ink-soft">{t(`area.guard.purposes.${row.purpose}`, row.purpose)}</td>
                      <td className="px-3 py-2">
                        <Badge tone={EVENT_TONE[row.eventType]}>{t(`area.admin.visitorMovement.events.${row.eventType}`)}</Badge>
                      </td>
                      <td className="px-3 py-2 text-[13px] text-muted">{row.gateName ?? '—'}</td>
                      <td className="px-3 py-2 text-[13px] text-muted">{row.performedBy ?? '—'}</td>
                      <td className="px-3 py-2 text-[13px] text-muted">
                        {row.rejectionReason ? t(`area.guard.rejectionReasons.${row.rejectionReason}`, row.rejectionReason) : '—'}
                        {row.rejectionNote ? ` · ${row.rejectionNote}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {total > rows.length && (
              <div className="w-fit">
                <RowButton onClick={() => setShown(shown + PAGE)}>
                  {t('area.admin.visitorMovement.showMore', { count: total - rows.length })}
                </RowButton>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  )
}
