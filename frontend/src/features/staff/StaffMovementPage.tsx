import { BadgeCheck } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, type Tone } from '../../components/ui/Badge'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import type { AuthUser } from '../auth/api'
import { listStaffMovements, type StaffMovement, type StaffMovementFilters } from '../gate/api'
import { today } from '../../lib/day'
import { FormGrid, Panel, RowButton } from '../society/parts'
import { useResource } from '../society/useResource'

const PAGE = 50
const EVENT_TONE: Record<StaffMovement['eventType'], Tone> = { ENTRY: 'positive', EXIT: 'neutral', ENTRY_REJECTED: 'danger' }
const stamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

/**
 * The office's audit of staff movement: entries, exits and refused entries, newest first. It reads
 * what the gate recorded and changes nothing; a profile going inactive never removes its history.
 */
export function StaffMovementPage({ user, accessToken }: { user: AuthUser; accessToken: string }) {
  const { t } = useTranslation()
  const societyId = user.societyId
  const [filters, setFilters] = useState<StaffMovementFilters>({})
  const [shown, setShown] = useState(PAGE)
  const query = { ...filters, limit: shown }
  const log = useResource(
    societyId ? () => listStaffMovements(accessToken, societyId, query) : null,
    [accessToken, societyId, shown, filters.staffType, filters.eventType, filters.verificationStatus, filters.dateFrom, filters.dateTo],
  )

  if (!societyId) return <ErrorState message={t('area.guard.noSociety')} />

  const set = (patch: StaffMovementFilters) => {
    setShown(PAGE)
    setFilters((current) => ({ ...current, ...patch }))
  }
  const rows = log.data?.movements ?? []
  const total = log.data?.total ?? 0

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.admin.staffMovement.title')}</h1>
        <p className="text-[13px] text-muted">{t('area.admin.staffMovement.intro')}</p>
      </header>

      <Panel title={t('area.admin.staffMovement.filtersTitle')} description={t('area.admin.staffMovement.filtersDescription')}>
        <FormGrid>
          <TextField
            id="movement-staff-type"
            label={t('area.admin.staffMovement.staffType')}
            value={filters.staffType ?? ''}
            onChange={(event) => set({ staffType: event.target.value || undefined })}
            placeholder={t('area.admin.staffMovement.staffTypePlaceholder')}
            maxLength={60}
          />
          <Select
            id="movement-event"
            label={t('area.admin.staffMovement.event')}
            options={[
              { value: '', label: t('area.admin.staffMovement.allEvents') },
              ...(['ENTRY', 'EXIT', 'ENTRY_REJECTED'] as const).map((value) => ({
                value,
                label: t(`area.admin.staffMovement.events.${value}`),
              })),
            ]}
            value={filters.eventType ?? ''}
            onChange={(event) => set({ eventType: (event.target.value || undefined) as StaffMovementFilters['eventType'] })}
          />
          <Select
            id="movement-verification"
            label={t('area.admin.staffMovement.verification')}
            options={[
              { value: '', label: t('area.admin.staffMovement.allVerifications') },
              { value: 'VERIFIED', label: t('area.admin.staffMovement.verified') },
              { value: 'REJECTED', label: t('area.admin.staffMovement.rejected') },
            ]}
            value={filters.verificationStatus ?? ''}
            onChange={(event) =>
              set({ verificationStatus: (event.target.value || undefined) as StaffMovementFilters['verificationStatus'] })
            }
          />
          <TextField
            id="movement-from"
            type="date"
            label={t('area.admin.staffMovement.from')}
            value={filters.dateFrom ?? ''}
            max={today()}
            onChange={(event) => set({ dateFrom: event.target.value || undefined })}
          />
          <TextField
            id="movement-to"
            type="date"
            label={t('area.admin.staffMovement.to')}
            value={filters.dateTo ?? ''}
            max={today()}
            onChange={(event) => set({ dateTo: event.target.value || undefined })}
          />
        </FormGrid>
      </Panel>

      <Panel
        title={t('area.admin.staffMovement.listTitle')}
        description={t('area.admin.staffMovement.listDescription', { count: total })}
      >
        {log.loading ? (
          <Skeleton rows={4} />
        ) : log.error ? (
          <ErrorState message={log.error} onRetry={log.reload} />
        ) : rows.length === 0 ? (
          <EmptyState icon={BadgeCheck} title={t('area.admin.staffMovement.empty.title')} description={t('area.admin.staffMovement.empty.description')} />
        ) : (
          <>
            <div className="overflow-auto rounded-xl border border-line">
              <table className="w-full border-collapse">
                <thead className="bg-canvas">
                  <tr>
                    {['when', 'staff', 'type', 'event', 'gate', 'by', 'reason'].map((column) => (
                      <th key={column} className="px-3 py-2 text-left text-[11px] font-bold tracking-wide text-muted uppercase">
                        {t(`area.admin.staffMovement.columns.${column}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.id}-${row.eventType}`} className="border-t border-line">
                      <td className="px-3 py-2 text-[13px] font-semibold text-ink">{stamp(row.at)}</td>
                      <td className="px-3 py-2 text-[13px] text-ink">{row.name}</td>
                      <td className="px-3 py-2 text-[13px] text-ink-soft">{row.staffType}</td>
                      <td className="px-3 py-2">
                        <Badge tone={EVENT_TONE[row.eventType]}>{t(`area.admin.staffMovement.events.${row.eventType}`)}</Badge>
                      </td>
                      <td className="px-3 py-2 text-[13px] text-muted">{row.gateName ?? '—'}</td>
                      <td className="px-3 py-2 text-[13px] text-muted">{row.performedBy ?? '—'}</td>
                      <td className="px-3 py-2 text-[13px] text-muted">
                        {row.rejectionReason ? t(`area.guard.gate.rejectReasons.${row.rejectionReason}`) : '—'}
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
                  {t('area.admin.staffMovement.showMore', { count: total - rows.length })}
                </RowButton>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  )
}
