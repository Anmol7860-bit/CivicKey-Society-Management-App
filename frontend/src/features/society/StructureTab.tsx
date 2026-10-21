import { Building2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, type Tone } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { EmptyState, ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import { getOccupancy, updateSociety, type Occupancy, type OccupancyFlat, type Society } from './api'
import { FormGrid, Panel, useAction } from './parts'
import { useResource } from './useResource'

const OCCUPANCY_TONE: Record<OccupancyFlat['occupancy'], Tone> = { VACANT: 'neutral', SHARING: 'warning', FULL: 'positive' }

/** One flat in the hierarchy, with what is sold, who lives there and how many may still join. */
function FlatRow({ flat }: { flat: OccupancyFlat }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line/60 px-4 py-2.5 first:border-t-0">
      <span className="w-20 text-[14px] font-semibold text-ink">{flat.number}</span>
      <Badge tone={flat.ownership === 'OWNED' ? 'brand' : 'neutral'}>{t(`area.admin.society.ownership.${flat.ownership}`)}</Badge>
      <Badge tone={OCCUPANCY_TONE[flat.occupancy]}>{t(`area.admin.society.occupancy.${flat.occupancy}`)}</Badge>
      {flat.status === 'INACTIVE' && <Badge tone="danger">{t('area.admin.society.status.INACTIVE')}</Badge>}
      <span className="ml-auto text-[12px] text-muted">
        {t('area.admin.society.structure.counts', { owners: flat.owners, tenants: flat.tenants })}
        {flat.sharingAllowed && flat.slotsLeft !== null && ` · ${t('area.admin.society.structure.slotsLeft', { count: flat.slotsLeft })}`}
      </span>
    </div>
  )
}

function Hierarchy({ occupancy }: { occupancy: Occupancy }) {
  const { t } = useTranslation()
  if (occupancy.blocks.length === 0) {
    return <EmptyState icon={Building2} title={t('area.admin.society.blocks.empty.title')} description={t('area.admin.society.blocks.empty.description')} />
  }
  return (
    <div className="flex flex-col gap-4">
      {occupancy.blocks.map((block) => (
        <div key={block.id} className="overflow-hidden rounded-xl border border-line">
          <div className="flex items-center gap-2 bg-canvas px-4 py-2.5">
            <h3 className="text-[14px] font-bold text-ink">{t('area.admin.society.structure.block', { name: block.name })}</h3>
            {block.status === 'INACTIVE' && <Badge tone="danger">{t('area.admin.society.status.INACTIVE')}</Badge>}
          </div>
          {block.floors.map((floor) => (
            <div key={floor.id} className="border-t border-line">
              <div className="flex items-center gap-2 px-4 py-2">
                <span className="text-[13px] font-semibold text-ink-soft">{floor.floorLabel}</span>
                {floor.status === 'INACTIVE' && <Badge tone="danger">{t('area.admin.society.status.INACTIVE')}</Badge>}
              </div>
              {floor.flats.length === 0 ? (
                <p className="px-4 pb-3 text-[12px] text-subtle">{t('area.admin.society.structure.noFlats')}</p>
              ) : (
                floor.flats.map((flat) => <FlatRow key={flat.id} flat={flat} />)
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** Society details the Admin may change, and the whole block → floor → flat hierarchy beneath it. */
export function StructureTab({ token, society, onSocietyChange }: {
  token: string
  society: Society
  onSocietyChange: (society: Society) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(society.name)
  const [address, setAddress] = useState(society.address ?? '')
  const [saved, setSaved] = useState(false)
  const action = useAction()
  const occupancy = useResource(() => getOccupancy(token, society.id), [token, society.id])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const updated = await action.run(async () => onSocietyChange(await updateSociety(token, society.id, { name, address })))
    setSaved(updated)
  }

  const summary = occupancy.data?.summary
  const tiles = summary
    ? ([
        ['flats', summary.flats],
        ['owned', summary.owned],
        ['unsold', summary.unsold],
        ['occupied', summary.occupied],
        ['vacant', summary.vacant],
        ['sharingAvailable', summary.sharingAvailable],
      ] as const)
    : []

  return (
    <div className="flex flex-col gap-4">
      <Panel title={t('area.admin.society.details.title')} description={t('area.admin.society.details.description')}>
        {saved && <SuccessNote message={t('area.admin.society.details.saved')} onDismiss={() => setSaved(false)} />}
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          <FormGrid>
            <TextField
              id="society-name"
              label={t('area.admin.society.details.name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              error={action.fieldError('name')}
              maxLength={160}
              required
            />
            <TextField
              id="society-address"
              label={t('area.admin.society.details.address')}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              error={action.fieldError('address')}
              maxLength={500}
            />
          </FormGrid>
          {action.error && <ErrorState message={action.error} />}
          <div className="sm:w-[180px]">
            <Button type="submit" disabled={action.pending || !name.trim()}>
              {action.pending ? t('shell.saving') : t('shell.save')}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel title={t('area.admin.society.structure.title')} description={t('area.admin.society.structure.description')}>
        {tiles.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {tiles.map(([key, value]) => (
              <div key={key} className="rounded-xl border border-line p-3">
                <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t(`area.admin.society.summary.${key}`)}</p>
                <p className="text-[22px] font-bold text-ink">{value}</p>
              </div>
            ))}
          </div>
        )}
        {occupancy.loading ? (
          <Skeleton rows={4} />
        ) : occupancy.error ? (
          <ErrorState message={occupancy.error} onRetry={occupancy.reload} />
        ) : (
          occupancy.data && <Hierarchy occupancy={occupancy.data} />
        )}
      </Panel>
    </div>
  )
}
