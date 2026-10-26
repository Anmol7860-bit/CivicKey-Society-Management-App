import { useTranslation } from 'react-i18next'
import { ErrorState, Skeleton } from '../../components/ui/States'
import { listMyFlats } from '../society/api'
import { useResource } from '../society/useResource'
import { DailyHelpPanel, RequestsPanel } from './FlatExtras'

/**
 * Everything about the flat's daily help on one screen: who works here with the office's
 * verification against each name, and the request that adds a new one. My flat no longer repeats it.
 */
export function DailyHelpPage({ accessToken }: { accessToken: string }) {
  const { t } = useTranslation()
  const mine = useResource(() => listMyFlats(accessToken), [accessToken])

  if (mine.loading) return <Skeleton rows={4} />
  if (mine.error) return <ErrorState message={mine.error} onRetry={mine.reload} />

  // Only a full-access, current assignment may ask the office for a new daily help
  const writableFlatId = mine.data?.find((assignment) => assignment.active && assignment.accessLevel === 'FULL')?.flatId

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.resident.nav.dailyHelp')}</h1>
        <p className="text-[13px] text-muted">{t('area.resident.dailyHelp.intro')}</p>
      </header>
      <DailyHelpPanel accessToken={accessToken} />
      <RequestsPanel accessToken={accessToken} flatId={writableFlatId} only="DAILY_HELP" />
    </div>
  )
}
