import { DoorClosed } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import { createFlat, listFlats, listFloors, updateFlat, type Block, type Flat } from './api'
import { Panel, RowButton, useAction, useDeactivate } from './parts'
import { useResource } from './useResource'

function FlatRow({ flat, token, onChanged, onDeactivate, onManage }: {
  flat: Flat
  token: string
  onChanged: () => void
  onDeactivate: (flat: Flat) => void
  onManage: (flat: Flat) => void
}) {
  const { t } = useTranslation()
  const [number, setNumber] = useState(flat.number)
  const [sharing, setSharing] = useState(flat.sharingAllowed)
  const [cap, setCap] = useState(flat.maxOccupants === null ? '' : String(flat.maxOccupants))
  const [editing, setEditing] = useState(false)
  const action = useAction()

  async function handleSave(event: FormEvent) {
    event.preventDefault()
    const body = { number, sharingAllowed: sharing, maxOccupants: sharing && cap.trim() ? Number(cap) : null }
    if (await action.run(() => updateFlat(token, flat.id, body))) {
      setEditing(false)
      onChanged()
    }
  }

  if (editing) {
    return (
      <form onSubmit={handleSave} className="flex flex-wrap items-end gap-3 border-t border-line px-4 py-3" noValidate>
        <div className="w-[150px]">
          <TextField
            id={`flat-number-${flat.id}`}
            label={t('area.admin.society.flats.number')}
            value={number}
            onChange={(event) => setNumber(event.target.value)}
            error={action.fieldError('number') ?? action.error}
            maxLength={16}
            autoFocus
          />
        </div>
        <label className="flex h-[46px] items-center gap-2 text-[13px] font-semibold text-ink-soft">
          <input type="checkbox" checked={sharing} onChange={(event) => setSharing(event.target.checked)} className="size-4 accent-[#176b62]" />
          {t('area.admin.society.flats.sharing')}
        </label>
        <div className="w-[150px]">
          <TextField
            id={`flat-cap-${flat.id}`}
            label={t('area.admin.society.flats.maxOccupants')}
            type="number"
            min={2}
            max={50}
            value={cap}
            onChange={(event) => setCap(event.target.value)}
            error={action.fieldError('maxOccupants')}
            disabled={!sharing}
          />
        </div>
        <div className="flex gap-2 pb-0.5">
          <RowButton onClick={() => setEditing(false)}>{t('shell.cancel')}</RowButton>
          <button
            type="submit"
            disabled={action.pending || !number.trim()}
            className="h-9 cursor-pointer rounded-lg bg-brand px-3 text-[13px] font-semibold text-white hover:bg-[#125a52] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {action.pending ? t('shell.saving') : t('shell.save')}
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
      <span className="text-[14px] font-semibold text-ink">{flat.number}</span>
      <Badge tone={flat.status === 'ACTIVE' ? 'positive' : 'danger'}>{t(`area.admin.society.status.${flat.status}`)}</Badge>
      {flat.sharingAllowed && (
        <Badge tone="warning">
          {flat.maxOccupants === null
            ? t('area.admin.society.flats.sharingUncapped')
            : t('area.admin.society.flats.sharingCapped', { count: flat.maxOccupants })}
        </Badge>
      )}
      <div className="ml-auto flex gap-2">
        <RowButton onClick={() => onManage(flat)}>{t('area.admin.society.flats.manageResidents')}</RowButton>
        <RowButton onClick={() => setEditing(true)}>{t('shell.edit')}</RowButton>
        {flat.status === 'ACTIVE' && (
          <RowButton tone="danger" onClick={() => onDeactivate(flat)}>
            {t('shell.deactivate')}
          </RowButton>
        )}
      </div>
    </div>
  )
}

/** Flats of the selected floor. A flat cannot be created until a block and one of its floors is chosen. */
export function FlatsTab({ token, blocks, blockId, onBlockChange, onManageResidents }: {
  token: string
  blocks: Block[]
  blockId: string
  onBlockChange: (blockId: string) => void
  onManageResidents: (flat: Flat) => void
}) {
  const { t } = useTranslation()
  const floors = useResource(blockId ? () => listFloors(token, blockId) : null, [token, blockId])
  const [floorId, setFloorId] = useState('')
  const [number, setNumber] = useState('')
  const [sharing, setSharing] = useState(false)
  const [cap, setCap] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const action = useAction()

  // Only floors of the chosen block may be selected, and the selection is dropped when the block changes
  const floorOptions = (floors.data ?? []).map((floor) => ({
    value: floor.id,
    label: floor.status === 'ACTIVE' ? floor.floorLabel : `${floor.floorLabel} · ${t('area.admin.society.status.INACTIVE')}`,
  }))
  const selectedFloor = floorOptions.some((option) => option.value === floorId) ? floorId : ''

  const flats = useResource(selectedFloor ? () => listFlats(token, selectedFloor) : null, [token, selectedFloor])

  const deactivate = useDeactivate<Flat>({
    title: t('area.admin.society.flats.deactivate.title'),
    description: (flat) => t('area.admin.society.flats.deactivate.description', { number: flat.number }),
    confirmLabel: t('shell.deactivate'),
    onConfirm: async (flat, reason) => {
      await updateFlat(token, flat.id, { status: 'INACTIVE', reason })
      flats.reload()
    },
  })

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    const body = { number: number.trim(), sharingAllowed: sharing, maxOccupants: sharing && cap.trim() ? Number(cap) : null }
    if (await action.run(() => createFlat(token, selectedFloor, body))) {
      setCreated(number.trim())
      setNumber('')
      setCap('')
      flats.reload()
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel title={t('area.admin.society.flats.add')} description={t('area.admin.society.flats.addDescription')}>
        {created && <SuccessNote message={t('area.admin.society.flats.created', { number: created })} onDismiss={() => setCreated(null)} />}
        <form className="flex flex-col gap-4" onSubmit={handleCreate} noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Select
              id="flat-block"
              label={t('area.admin.society.blocks.one')}
              options={blocks.map((block) => ({ value: block.id, label: block.name }))}
              placeholder={t('area.admin.society.floors.chooseBlock')}
              value={blockId}
              onChange={(event) => {
                onBlockChange(event.target.value)
                setFloorId('')
              }}
              required
            />
            <Select
              id="flat-floor"
              label={t('area.admin.society.floors.one')}
              options={floorOptions}
              placeholder={blockId ? t('area.admin.society.flats.chooseFloor') : t('area.admin.society.flats.chooseBlockFirst')}
              value={selectedFloor}
              onChange={(event) => setFloorId(event.target.value)}
              disabled={!blockId || floors.loading}
              required
            />
            <TextField
              id="new-flat-number"
              label={t('area.admin.society.flats.number')}
              value={number}
              onChange={(event) => setNumber(event.target.value)}
              error={action.fieldError('number') ?? action.error}
              placeholder={t('area.admin.society.flats.numberPlaceholder')}
              maxLength={16}
              disabled={!selectedFloor}
              required
            />
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-[13px] font-semibold text-ink-soft">
                <input
                  type="checkbox"
                  checked={sharing}
                  onChange={(event) => setSharing(event.target.checked)}
                  disabled={!selectedFloor}
                  className="size-4 accent-[#176b62]"
                />
                {t('area.admin.society.flats.sharing')}
              </label>
              <TextField
                id="new-flat-cap"
                label={t('area.admin.society.flats.maxOccupants')}
                type="number"
                min={2}
                max={50}
                value={cap}
                onChange={(event) => setCap(event.target.value)}
                error={action.fieldError('maxOccupants')}
                hint={t('area.admin.society.flats.maxOccupantsHint')}
                disabled={!sharing}
              />
            </div>
          </div>
          <div className="sm:w-[180px]">
            <Button type="submit" disabled={action.pending || !selectedFloor || !number.trim()}>
              {action.pending ? t('shell.saving') : t('area.admin.society.flats.addAction')}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel title={t('area.admin.society.flats.title')}>
        {!selectedFloor ? (
          <EmptyState icon={DoorClosed} title={t('area.admin.society.flats.chooseFirst')} description={t('area.admin.society.flats.chooseFirstDescription')} />
        ) : flats.loading ? (
          <Skeleton />
        ) : flats.error ? (
          <ErrorState message={flats.error} onRetry={flats.reload} />
        ) : flats.data?.length ? (
          <div className="overflow-hidden rounded-xl border border-line [&>*:first-child]:border-t-0">
            {flats.data.map((flat) => (
              <FlatRow
                key={flat.id}
                flat={flat}
                token={token}
                onChanged={flats.reload}
                onDeactivate={deactivate.ask}
                onManage={onManageResidents}
              />
            ))}
          </div>
        ) : (
          <EmptyState icon={DoorClosed} title={t('area.admin.society.flats.empty.title')} description={t('area.admin.society.flats.empty.description')} />
        )}
      </Panel>
      {deactivate.dialog}
    </div>
  )
}
