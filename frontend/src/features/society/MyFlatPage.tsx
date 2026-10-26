import { Home } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States'
import { RequestsPanel, VehiclesPanel } from '../gate/FlatExtras'
import { listMyFlats, type MyAssignment } from './api'
import { Panel } from './parts'
import { useResource } from './useResource'

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</span>
      <span className="text-[14px] font-semibold text-ink">{value}</span>
    </div>
  )
}

function Assignment({ assignment }: { assignment: MyAssignment }) {
  const { t } = useTranslation()
  const { flat, floor, block, society } = assignment
  const place = t('area.resident.myFlat.place', { block: block.name, floor: floor.floorLabel, number: flat.number })

  return (
    <Panel title={place} description={society.name}>
      <div className="flex flex-wrap gap-2">
        <Badge tone={assignment.residentType === 'OWNER' ? 'brand' : 'neutral'}>
          {t(`area.admin.society.residents.type.${assignment.residentType}`)}
        </Badge>
        <Badge tone={assignment.verificationStatus === 'VERIFIED' ? 'positive' : assignment.verificationStatus === 'PENDING' ? 'warning' : 'danger'}>
          {t(`area.admin.society.residents.status.${assignment.verificationStatus}`)}
        </Badge>
        <Badge tone={assignment.accessLevel === 'FULL' ? 'brand' : 'neutral'}>
          {t(`area.admin.society.residents.access.${assignment.accessLevel}`)}
        </Badge>
        {!assignment.active && assignment.verificationStatus === 'VERIFIED' && <Badge tone="danger">{t('area.resident.myFlat.ceased')}</Badge>}
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Detail label={t('area.resident.myFlat.from')} value={assignment.startDate} />
        <Detail label={t('area.resident.myFlat.until')} value={assignment.endDate ?? t('area.admin.society.residents.noEnd')} />
        {assignment.idDocumentOnFile && assignment.idDocumentType && (
          <Detail
            label={t('area.resident.myFlat.idOnFile')}
            value={`${t(`area.admin.society.residents.idType.${assignment.idDocumentType}`)} ····${assignment.idDocumentLast4 ?? ''}`}
          />
        )}
        {assignment.flat.sharingAllowed && (
          <Detail
            label={t('area.resident.myFlat.sharing')}
            value={
              assignment.flat.maxOccupants === null
                ? t('area.admin.society.flats.sharingUncapped')
                : t('area.admin.society.flats.sharingCapped', { count: assignment.flat.maxOccupants })
            }
          />
        )}
      </div>

      {assignment.verificationStatus === 'PENDING' && <p className="text-[13px] text-muted">{t('area.resident.myFlat.waiting')}</p>}
      {assignment.verificationStatus === 'REJECTED' && assignment.rejectedReason && (
        <p className="text-[13px] text-red-700">{t('area.admin.society.residents.rejectedFor', { reason: assignment.rejectedReason })}</p>
      )}
      {!assignment.active && assignment.verificationStatus === 'VERIFIED' && (
        <p className="text-[13px] text-muted">{t('area.resident.myFlat.ceasedNote')}</p>
      )}

      {assignment.household.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line">
          <p className="bg-canvas px-4 py-2 text-[12px] font-bold tracking-wide text-muted uppercase">{t('area.resident.myFlat.household')}</p>
          {assignment.household.map((member) => (
            <div key={member.name} className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
              <span className="text-[14px] font-semibold text-ink">{member.name}</span>
              <Badge tone={member.residentType === 'OWNER' ? 'brand' : 'neutral'}>
                {t(`area.admin.society.residents.type.${member.residentType}`)}
              </Badge>
              <Badge tone={member.accessLevel === 'FULL' ? 'brand' : 'neutral'}>
                {t(`area.admin.society.residents.access.${member.accessLevel}`)}
              </Badge>
            </div>
          ))}
        </div>
      )}
      {assignment.active && assignment.accessLevel === 'VIEW_ONLY' && <p className="text-[13px] text-muted">{t('area.resident.myFlat.viewOnly')}</p>}
    </Panel>
  )
}

/**
 * The resident's own flat: the assignment the Admin approved, the household they are allowed to
 * see, and nothing about managing the society. An expired tenancy shows as ceased.
 */
export function MyFlatPage({ accessToken }: { accessToken: string }) {
  const { t } = useTranslation()
  const mine = useResource(() => listMyFlats(accessToken), [accessToken])

  if (mine.loading) return <Skeleton rows={4} />
  if (mine.error) return <ErrorState message={mine.error} onRetry={mine.reload} />

  // Only a full-access, current assignment may add a vehicle or ask the office for anything
  const writableFlatId = mine.data?.find((assignment) => assignment.active && assignment.accessLevel === 'FULL')?.flatId

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.resident.nav.myFlat')}</h1>
        <p className="text-[13px] text-muted">{t('area.resident.myFlat.intro')}</p>
      </header>
      {mine.data?.length ? (
        mine.data.map((assignment) => <Assignment key={assignment.id} assignment={assignment} />)
      ) : (
        <EmptyState icon={Home} title={t('area.resident.myFlat.empty.title')} description={t('area.resident.myFlat.empty.description')} />
      )}

      {mine.data && mine.data.length > 0 && (
        <>
          <VehiclesPanel accessToken={accessToken} flatId={writableFlatId} />
          <RequestsPanel accessToken={accessToken} flatId={writableFlatId} only="HOUSEHOLD_MEMBER" />
        </>
      )}
    </div>
  )
}
