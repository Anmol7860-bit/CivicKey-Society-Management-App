import { BellOff } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States'
import type { AuthUser } from '../auth/api'
import { Panel, RowButton } from '../society/parts'
import { EventRow } from './ActivityPage'
import { useFeed } from './feed'

/** How much of the settled history is worth showing beside what still needs doing. */
const RECENT = 15
const SEEN_KEY = 'civickey:notifications-seen'

/** Per-browser and best-effort: a blocked or cleared store simply means everything reads as new. */
function readSeen() {
  try {
    return localStorage.getItem(SEEN_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeSeen(value: string) {
  try {
    localStorage.setItem(SEEN_KEY, value)
  } catch {
    // Nothing to do: the marker is a convenience, not a record
  }
}

/**
 * What the flat still has to answer, and what has happened since the resident last looked.
 * Built from the same records as My activity, so there is no separate notification to deliver,
 * fail to deliver, or leave stale.
 */
export function NotificationsPage({ user, accessToken }: { user: AuthUser; accessToken: string }) {
  const { t } = useTranslation()
  const [seen, setSeen] = useState(readSeen)
  const feed = useFeed(accessToken)
  const area = user.role === 'ADMIN' ? 'admin' : 'resident'

  if (feed.loading) return <Skeleton rows={5} />
  if (feed.error) return <ErrorState message={feed.error} onRetry={feed.reload} />

  const pending = feed.events.filter((event) => event.pending)
  const rest = feed.events.filter((event) => !event.pending)
  const unread = rest.filter((event) => event.at > seen)

  function markRead() {
    const now = new Date().toISOString()
    writeSeen(now)
    setSeen(now)
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.resident.notifications.title')}</h1>
        <p className="text-[13px] text-muted">{t('area.resident.notifications.intro')}</p>
      </header>

      <Panel
        title={t('area.resident.notifications.pendingTitle')}
        description={t('area.resident.notifications.pendingDescription')}
      >
        {pending.length === 0 ? (
          <EmptyState
            icon={BellOff}
            title={t('area.resident.notifications.clear.title')}
            description={t('area.resident.notifications.clear.description')}
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-line [&>*:first-child]:border-t-0">
            {pending.map((event) => (
              <EventRow key={event.id} event={event} area={area} />
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title={t('area.resident.notifications.recentTitle')}
        description={t('area.resident.notifications.recentDescription')}
        action={
          unread.length > 0 ? (
            <RowButton onClick={markRead}>{t('area.resident.notifications.markRead', { count: unread.length })}</RowButton>
          ) : undefined
        }
      >
        {rest.length === 0 ? (
          <EmptyState
            icon={BellOff}
            title={t('area.resident.notifications.empty.title')}
            description={t('area.resident.notifications.empty.description')}
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-line [&>*:first-child]:border-t-0">
            {rest.slice(0, RECENT).map((event) => (
              <div key={event.id} className={event.at > seen ? 'bg-brand/5' : undefined}>
                <EventRow event={event} area={area} />
              </div>
            ))}
          </div>
        )}
      </Panel>

      <p className="text-[12px] text-muted">{t('area.resident.notifications.footnote')}</p>
    </div>
  )
}
