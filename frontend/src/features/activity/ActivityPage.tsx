import { CreditCard, History, QrCode, UserCheck, UserPlus, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge } from '../../components/ui/Badge'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States'
import type { AuthUser } from '../auth/api'
import { Panel } from '../society/parts'
import { useFeed, type FeedEvent, type FeedKind } from './feed'

const ICON: Record<FeedKind, LucideIcon> = { VISIT: UserCheck, PASS: QrCode, BILL: CreditCard, REQUEST: UserPlus }
const KINDS: FeedKind[] = ['VISIT', 'PASS', 'BILL', 'REQUEST']

const stamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

/** The day heading a run of events sits under, e.g. "Today" or "21 Oct 2026". */
function dayOf(value: string, t: ReturnType<typeof useTranslation>['t']) {
  const date = new Date(value)
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days <= 0) return t('area.resident.activity.today')
  if (days === 1) return t('area.resident.activity.yesterday')
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function EventRow({ event, area }: { event: FeedEvent; area: string }) {
  const { t } = useTranslation()
  const Icon = ICON[event.kind]

  return (
    <div className="flex gap-3 border-t border-line px-4 py-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
        <Icon size={16} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-semibold text-ink">
            {t(`area.resident.activity.events.${event.event}`, event.values)}
          </span>
          <Badge tone={event.tone}>{t(`area.resident.activity.kinds.${event.kind}`)}</Badge>
        </div>
        <p className="text-[12px] text-muted">
          {stamp(event.at)}
          {event.to && (
            <>
              {' · '}
              <Link to={`/${area}/${event.to}`} className="font-semibold text-brand hover:underline">
                {t('area.resident.activity.open')}
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  )
}

/**
 * The resident's own history: visitors, passes, bills and requests on one timeline, read from
 * the records themselves rather than a separate log, so it can never drift from them.
 */
export function ActivityPage({ user, accessToken }: { user: AuthUser; accessToken: string }) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<FeedKind | 'ALL'>('ALL')
  const feed = useFeed(accessToken)
  const area = user.role === 'ADMIN' ? 'admin' : 'resident'

  if (feed.loading) return <Skeleton rows={6} />
  if (feed.error) return <ErrorState message={feed.error} onRetry={feed.reload} />

  const shown = kind === 'ALL' ? feed.events : feed.events.filter((event) => event.kind === kind)
  const counts = Object.fromEntries(KINDS.map((key) => [key, feed.events.filter((event) => event.kind === key).length]))

  // Events are already newest first, so each day's run becomes one group
  const groups: { day: string; events: FeedEvent[] }[] = []
  for (const event of shown) {
    const day = dayOf(event.at, t)
    if (groups.at(-1)?.day === day) groups.at(-1)!.events.push(event)
    else groups.push({ day, events: [event] })
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.resident.activity.title')}</h1>
        <p className="text-[13px] text-muted">{t('area.resident.activity.intro')}</p>
      </header>

      <Panel title={t('area.resident.activity.timelineTitle')} description={t('area.resident.activity.timelineDescription')}>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('area.resident.activity.filterLabel')}>
          {(['ALL', ...KINDS] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={kind === key}
              onClick={() => setKind(key)}
              className={`h-9 cursor-pointer rounded-lg border px-3 text-[13px] font-semibold transition-colors ${
                kind === key ? 'border-brand bg-brand text-white' : 'border-line-strong bg-white text-ink-soft hover:bg-canvas'
              }`}
            >
              {key === 'ALL'
                ? t('area.resident.activity.kinds.ALL', { count: feed.events.length })
                : t('area.resident.activity.kinds.filter', { kind: t(`area.resident.activity.kinds.${key}`), count: counts[key] })}
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <EmptyState icon={History} title={t('area.resident.activity.empty.title')} description={t('area.resident.activity.empty.description')} />
        ) : (
          <div className="overflow-hidden rounded-xl border border-line">
            {groups.map((group) => (
              <div key={group.day}>
                <p className="border-t border-line bg-canvas px-4 py-1.5 text-[11px] font-bold tracking-wide text-muted uppercase first:border-t-0">
                  {group.day}
                </p>
                {group.events.map((event) => (
                  <EventRow key={event.id} event={event} area={area} />
                ))}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}
