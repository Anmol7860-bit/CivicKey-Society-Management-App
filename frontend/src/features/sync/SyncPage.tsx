import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { syncNow, type QueueStatus } from './queue'
import { useSyncState } from './useSync'

const STATUS_STYLE: Record<QueueStatus, string> = {
  PENDING_SYNC: 'bg-amber-50 text-amber-800',
  SYNCING: 'bg-brand/10 text-brand',
  SYNCED: 'bg-emerald-50 text-emerald-800',
  FAILED_RETRY: 'bg-amber-50 text-amber-800',
  FAILED_ADMIN: 'bg-red-50 text-red-700',
}

/** Short sync status, e.g. "3 entries waiting to sync". Compact shows just the count on phones. */
export function SyncSummary({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const { meta, online } = useSyncState()
  const pending = meta?.pendingCount ?? 0
  const text = !online
    ? t('sync.summary.offline', { count: pending })
    : pending
      ? t('sync.summary.waiting', { count: pending })
      : t('sync.summary.synced')
  if (!compact) return <>{text}</>
  return (
    <>
      <span className="sm:hidden" aria-hidden>
        {online ? pending : `${t('sync.offline')} · ${pending}`}
      </span>
      <span className="sr-only sm:not-sr-only">{text}</span>
    </>
  )
}

/** The guard's Sync status page: what is waiting on this device, and a manual Sync button. */
export function SyncPage({ accessToken }: { accessToken: string }) {
  const { t, i18n } = useTranslation()
  const { meta, queue, online } = useSyncState()
  const [running, setRunning] = useState(false)
  const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language) : t('sync.never'))

  async function handleSync() {
    setRunning(true)
    await syncNow(accessToken).catch(() => {})
    setRunning(false)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-[22px] leading-7 text-ink">{t('area.guard.nav.sync')}</h1>
          <p className="text-[13px] text-muted" role="status">
            <SyncSummary />
          </p>
        </div>
        <button
          type="button"
          onClick={handleSync}
          disabled={running || meta?.status === 'SYNCING'}
          className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-lg bg-brand px-4 text-[14px] font-semibold text-white hover:bg-[#125a52] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-70"
        >
          <RefreshCw size={16} className={running ? 'animate-spin' : ''} aria-hidden />
          {running ? t('sync.syncing') : t('sync.syncNow')}
        </button>
      </div>

      <dl className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <div className="flex flex-col gap-1 rounded-xl border border-line bg-white p-3.5">
          <dt className="text-[11px] text-muted">{t('sync.connection')}</dt>
          <dd className="text-[15px] text-ink">{online ? t('sync.online') : t('sync.offline')}</dd>
        </div>
        <div className="flex flex-col gap-1 rounded-xl border border-line bg-white p-3.5">
          <dt className="text-[11px] text-muted">{t('sync.lastSynced')}</dt>
          <dd className="text-[15px] text-ink">{time(meta?.lastSyncedAt ?? null)}</dd>
        </div>
        <div className="flex flex-col gap-1 rounded-xl border border-line bg-white p-3.5">
          <dt className="text-[11px] text-muted">{t('sync.lastError')}</dt>
          <dd className="text-[15px] text-ink">{meta?.lastError ?? t('sync.none')}</dd>
        </div>
      </dl>

      <section className="flex flex-col gap-3 rounded-xl border border-line bg-white p-3.5" aria-labelledby="queue-title">
        <h2 id="queue-title" className="text-[13px] text-ink">
          {t('sync.queue')}
        </h2>
        {queue?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <thead className="text-[11px] text-muted">
                <tr>
                  <th className="py-2 pr-3 font-semibold">{t('sync.columns.recorded')}</th>
                  <th className="py-2 pr-3 font-semibold">{t('sync.columns.type')}</th>
                  <th className="py-2 pr-3 font-semibold">{t('sync.columns.status')}</th>
                  <th className="py-2 pr-3 font-semibold">{t('sync.columns.attempts')}</th>
                  <th className="py-2 font-semibold">{t('sync.columns.error')}</th>
                </tr>
              </thead>
              <tbody>
                {[...queue].reverse().map((record) => (
                  <tr key={record.clientEventId} className="border-t border-line">
                    <td className="py-2 pr-3 text-ink">{time(record.clientTs)}</td>
                    <td className="py-2 pr-3">{t(`sync.operations.${record.operationType}`)}</td>
                    <td className="py-2 pr-3">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[record.status]}`}>
                        {t(`sync.statuses.${record.status}`)}
                      </span>
                    </td>
                    <td className="py-2 pr-3">{record.retryCount}</td>
                    <td className="py-2">{record.lastErrorCode ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[12px] text-muted">{t('sync.empty')}</p>
        )}
        <p className="text-[12px] text-muted">{t('sync.liveNote')}</p>
      </section>
    </div>
  )
}
