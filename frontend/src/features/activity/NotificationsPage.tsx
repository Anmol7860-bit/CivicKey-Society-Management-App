import { Bell, BellOff, BellRing } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States'
import type { AuthUser } from '../auth/api'
import { markAllRead } from '../notification/api'
import { enablePush, pushState } from '../notification/push'
import { NOTIFICATION_ARRIVED, useLiveStatus, useNotifications } from '../notification/useNotifications'
import { Panel, RowButton, useAction } from '../society/parts'
import { EventRow } from './ActivityPage'
import { useFeed } from './feed'

/** How much of the settled history is worth showing beside what still needs doing. */
const RECENT = 15

/**
 * What was sent to this person, and what their flat still has to answer.
 *
 * The notifications come from the server now: they are records that were delivered, not a list
 * rebuilt from the visit log, so "read" means read on every device rather than in one browser.
 * The pending section still comes from the live feed, because what needs answering is a question
 * about the flat's current state rather than about what was sent.
 */
export function NotificationsPage({ user, accessToken }: { user: AuthUser; accessToken: string }) {
  const { t } = useTranslation()
  const sent = useNotifications(accessToken)
  const live = useLiveStatus()
  const feed = useFeed(accessToken)
  const area = user.role === 'ADMIN' ? 'admin' : 'resident'
  const readAction = useAction()
  const pushAction = useAction()
  const [push, setPush] = useState<'UNSUPPORTED' | 'DENIED' | 'ON' | 'OFF' | null>(null)

  useEffect(() => {
    void pushState().then(setPush)
  }, [])

  // A refresh keeps the page it refreshes: only a first load, with nothing on screen yet, waits
  if ((sent.loading && !sent.items) || feed.loading) return <Skeleton rows={5} />
  // A failed refresh keeps what was already loaded on the screen; only a first load with nothing
  // to show is replaced by the error
  if (sent.error && !sent.items) return <ErrorState message={sent.error} onRetry={sent.reload} />
  if (feed.error) return <ErrorState message={feed.error} onRetry={feed.reload} />

  const pending = feed.events.filter((event) => event.pending)
  const items = sent.items ?? []

  async function handleMarkRead() {
    // Every listener reloads, so the bell in the shell drops its badge with this page
    if (await readAction.run(() => markAllRead(accessToken))) window.dispatchEvent(new Event(NOTIFICATION_ARRIVED))
  }

  async function handleEnablePush() {
    await pushAction.run(async () => {
      const { subscribed } = await enablePush(accessToken)
      setPush(subscribed ? 'ON' : 'DENIED')
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.resident.notifications.title')}</h1>
        <p className="text-[13px] text-muted">{t('area.resident.notifications.intro')}</p>
      </header>

      {live === false && (
        <p className="rounded-xl border border-line bg-paper p-3 text-[12px] text-muted">
          {t('area.resident.notifications.offline')}
        </p>
      )}

      {push === 'OFF' && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-white p-3.5">
          <p className="text-[13px] text-ink">
            <BellRing size={15} className="mr-1.5 inline text-brand" aria-hidden />
            {t('area.resident.notifications.push.offer')}
          </p>
          <RowButton onClick={handleEnablePush} disabled={pushAction.pending}>
            {t('area.resident.notifications.push.enable')}
          </RowButton>
        </div>
      )}
      {push === 'DENIED' && <p className="text-[12px] text-muted">{t('area.resident.notifications.push.denied')}</p>}

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
        title={t('area.resident.notifications.sentTitle')}
        description={t('area.resident.notifications.sentDescription')}
        action={
          sent.unread > 0 ? (
            <RowButton onClick={handleMarkRead} disabled={readAction.pending}>
              {t('area.resident.notifications.markRead', { count: sent.unread })}
            </RowButton>
          ) : undefined
        }
      >
        {items.length === 0 ? (
          <EmptyState
            icon={BellOff}
            title={t('area.resident.notifications.empty.title')}
            description={t('area.resident.notifications.empty.description')}
          />
        ) : (
          <ul className="flex flex-col overflow-hidden rounded-xl border border-line">
            {items.slice(0, RECENT).map((item) => (
              <li
                key={item.id}
                className={`flex gap-3 border-t border-line p-3.5 first:border-t-0 ${item.readAt ? '' : 'bg-brand/5'}`}
              >
                <Bell size={15} className={`mt-0.5 shrink-0 ${item.readAt ? 'text-muted' : 'text-brand'}`} aria-hidden />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="text-[14px] text-ink">{item.title}</p>
                  <p className="text-[13px] text-muted">{item.body}</p>
                  <time className="text-[11px] text-muted" dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleString()}
                  </time>
                </div>
                {!item.readAt && <span className="sr-only">{t('area.resident.notifications.unread')}</span>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="text-[12px] text-muted">{t('area.resident.notifications.footnote')}</p>
    </div>
  )
}
