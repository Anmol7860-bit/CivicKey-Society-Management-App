import { Building2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, type Tone } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { EmptyState, ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import { getOccupancy, updateSociety, type Occupancy, type OccupancyFlat, type Society, type SocietyBody } from './api'
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
  const [form, setForm] = useState({
    name: society.name,
    registrationNumber: society.registrationNumber ?? '',
    gstin: society.gstin ?? '',
    address: society.address ?? '',
    pinCode: society.pinCode ?? '',
    city: society.city ?? '',
    state: society.state ?? '',
    officePhone: society.officePhone ?? '',
  })
  const set = <K extends keyof typeof form>(key: K, value: string) => setForm((previous) => ({ ...previous, [key]: value }))
  const [saved, setSaved] = useState(false)
  const action = useAction()
  const occupancy = useResource(() => getOccupancy(token, society.id), [token, society.id])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    // An emptied optional field is sent as null, which clears it; the name is always required
    const body: SocietyBody = {
      name: form.name.trim(),
      ...(Object.fromEntries(
        (['registrationNumber', 'gstin', 'address', 'pinCode', 'city', 'state', 'officePhone'] as const).map((key) => [
          key,
          form[key].trim() || null,
        ]),
      ) as Omit<SocietyBody, 'name'>),
    }
    const updated = await action.run(async () => onSocietyChange(await updateSociety(token, society.id, body)))
    setSaved(updated)
  }

  const field = (key: Exclude<keyof typeof form, never>, maxLength: number, extras: { required?: boolean; hint?: string } = {}) => (
    <TextField
      id={`society-${key}`}
      label={t(`area.admin.society.details.${key}`)}
      value={form[key]}
      onChange={(event) => set(key, event.target.value)}
      error={action.fieldError(key)}
      maxLength={maxLength}
      {...extras}
    />
  )

  return (
    <div className="flex flex-col gap-4">
      <Panel title={t('area.admin.society.details.title')} description={t('area.admin.society.details.description')}>
        {saved && <SuccessNote message={t('area.admin.society.details.saved')} onDismiss={() => setSaved(false)} />}
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          <FormGrid>
            {field('name', 160, { required: true })}
            {field('registrationNumber', 64)}
            {field('gstin', 15, { hint: t('area.admin.society.details.gstinHint') })}
            {field('address', 500, { required: true })}
            {field('pinCode', 6)}
            {field('city', 80)}
            {field('state', 80)}
            {field('officePhone', 15)}
          </FormGrid>
          {action.error && <ErrorState message={action.error} />}
          <div className="sm:w-[180px]">
            <Button type="submit" disabled={action.pending || !form.name.trim()}>
              {action.pending ? t('shell.saving') : t('shell.save')}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel title={t('area.admin.society.structure.title')} description={t('area.admin.society.structure.description')}>
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
