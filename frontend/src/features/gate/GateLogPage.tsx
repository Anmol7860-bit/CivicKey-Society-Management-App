import { ArrowDownLeft, ArrowUpRight, DoorOpen } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import type { AuthUser } from '../auth/api'
import { today as isoToday } from '../../lib/day'
import { Panel } from '../society/parts'
import { useResource } from '../society/useResource'
import { getGateLog } from './api'

const clock = (value: string) => new Date(value).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })

/** One number with its own line of explanation under it. */
function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <li className="flex flex-col gap-1 rounded-xl border border-line bg-white p-3.5">
      <span className="text-[11px] text-muted">{label}</span>
      <span className="text-[20px] leading-6 font-bold text-ink">{value}</span>
      <span className="text-[10px] leading-[13px] text-muted">{hint ?? ''}</span>
    </li>
  )
}

/**
 * The gate's record of one day: every entry and exit in the order they happened, and the numbers
 * a guard is asked for at handover. The gate screen answers "who is inside now"; this answers
 * "what happened on my shift", which is why they are two destinations and not one.
 */
export function GateLogPage({ user, accessToken }: { user: AuthUser; accessToken: string }) {
  const { t } = useTranslation()
  const societyId = user.societyId
  const [today] = useState(isoToday)
  const [on, setOn] = useState(today)
  const log = useResource(societyId ? () => getGateLog(accessToken, societyId, on) : null, [accessToken, societyId, on])

  if (!societyId) return <ErrorState message={t('area.guard.noSociety')} />

  const metrics = log.data?.metrics
  const stayed =
    metrics?.averageStayMinutes === null || metrics?.averageStayMinutes === undefined
      ? '—'
      : t('area.guard.log.minutes', { count: metrics.averageStayMinutes })
  const types = Object.entries(metrics?.byType ?? {}).sort((a, b) => b[1] - a[1])

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.guard.log.title')}</h1>
          <p className="text-[13px] text-muted">{t('area.guard.log.intro')}</p>
        </div>
        <div className="w-[190px]">
          <TextField
            id="gate-log-day"
            type="date"
            label={t('area.guard.log.day')}
            value={on}
            max={today}
            onChange={(event) => setOn(event.target.value || today)}
          />
        </div>
      </header>

      {log.loading ? (
        <Skeleton rows={4} />
      ) : log.error ? (
        <ErrorState message={log.error} onRetry={log.reload} />
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-2.5 lg:grid-cols-3" aria-label={t('area.guard.log.summary')}>
            <Metric label={t('area.guard.log.entries')} value={String(metrics?.entries ?? 0)} hint={t('area.guard.log.entriesHint')} />
            <Metric label={t('area.guard.log.exits')} value={String(metrics?.exits ?? 0)} hint={t('area.guard.log.exitsHint')} />
            <Metric
              label={t('area.guard.log.stillInside')}
              value={String(metrics?.stillInside ?? 0)}
              hint={
                metrics?.openOvernight
                  ? t('area.guard.log.openOvernight', { count: metrics.openOvernight })
                  : t('area.guard.log.allAccountedFor')
              }
            />
            <Metric label={t('area.guard.log.averageStay')} value={stayed} hint={t('area.guard.log.averageStayHint')} />
            <Metric
              label={t('area.guard.log.busiest')}
              value={
                metrics?.busiestHour
                  ? t('area.guard.log.hourRange', { from: metrics.busiestHour.hour, to: (metrics.busiestHour.hour + 1) % 24 })
                  : '—'
              }
              hint={metrics?.busiestHour ? t('area.guard.log.busiestHint', { count: metrics.busiestHour.entries }) : undefined}
            />
            <Metric label={t('area.guard.log.turnedAway')} value={String(metrics?.turnedAway ?? 0)} hint={t('area.guard.log.turnedAwayHint')} />
          </ul>

          {types.length > 0 && (
            <Panel title={t('area.guard.log.mixTitle')} description={t('area.guard.log.mixDescription')}>
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {types.map(([type, count]) => (
                  <li key={type} className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2">
                    <span className="text-[13px] font-semibold text-ink">
                      {type === 'STAFF' ? t('area.guard.log.staff') : t(`area.guard.purposes.${type}`)}
                    </span>
                    <Badge tone="neutral">{count}</Badge>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title={t('area.guard.log.movementsTitle')} description={t('area.guard.log.movementsDescription')}>
            {log.data?.movements.length ? (
              <div className="overflow-auto rounded-xl border border-line">
                <table className="w-full border-collapse">
                  <thead className="bg-canvas">
                    <tr>
                      {['time', 'direction', 'name', 'type', 'flat', 'gate', 'vehicle'].map((column) => (
                        <th key={column} className="px-3 py-2 text-left text-[11px] font-bold tracking-wide text-muted uppercase">
                          {t(`area.guard.log.columns.${column}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {log.data.movements.map((movement) => (
                      <tr key={`${movement.id}-${movement.direction}`} className="border-t border-line">
                        <td className="px-3 py-2 text-[13px] font-semibold text-ink">{clock(movement.at)}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-semibold ${
                              movement.direction === 'IN' ? 'bg-emerald-50 text-emerald-800' : 'bg-canvas text-ink-soft'
                            }`}
                          >
                            {movement.direction === 'IN' ? <ArrowDownLeft size={13} aria-hidden /> : <ArrowUpRight size={13} aria-hidden />}
                            {t(`area.guard.log.direction.${movement.direction}`)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-[13px] text-ink">{movement.name}</td>
                        <td className="px-3 py-2">
                          <Badge tone={movement.kind === 'STAFF' ? 'brand' : 'neutral'}>
                            {movement.kind === 'STAFF'
                              ? t(`area.admin.staff.kinds.${movement.type}`)
                              : t(`area.guard.purposes.${movement.type}`)}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-[13px] text-ink-soft">{movement.flat || '—'}</td>
                        <td className="px-3 py-2 text-[13px] text-muted">{movement.gateName ?? '—'}</td>
                        <td className="px-3 py-2 text-[13px] text-muted">{movement.vehicleNumber ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState icon={DoorOpen} title={t('area.guard.log.empty.title')} description={t('area.guard.log.empty.description')} />
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
