import { Layers } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import { createFloor, listFloors, updateFloor, type Block, type Floor } from './api'
import { Panel, RowButton, useAction, useDeactivate } from './parts'
import { useResource } from './useResource'

/** Sort order is optional and may be negative, so a basement sorts below the ground floor. */
const orderValue = (value: string) => (value.trim() === '' ? null : Number(value))

function FloorRow({ floor, token, onChanged, onDeactivate }: {
  floor: Floor
  token: string
  onChanged: () => void
  onDeactivate: (floor: Floor) => void
}) {
  const { t } = useTranslation()
  const [label, setLabel] = useState(floor.floorLabel)
  const [order, setOrder] = useState(floor.sortOrder === null ? '' : String(floor.sortOrder))
  const [editing, setEditing] = useState(false)
  const action = useAction()

  async function handleSave(event: FormEvent) {
    event.preventDefault()
    if (await action.run(() => updateFloor(token, floor.id, { floorLabel: label, sortOrder: orderValue(order) }))) {
      setEditing(false)
      onChanged()
    }
  }

  if (editing) {
    return (
      <form onSubmit={handleSave} className="flex flex-wrap items-end gap-3 border-t border-line px-4 py-3" noValidate>
        <div className="min-w-[200px] flex-1">
          <TextField
            id={`floor-label-${floor.id}`}
            label={t('area.admin.society.floors.label')}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            error={action.fieldError('floorLabel') ?? action.error}
            maxLength={80}
            autoFocus
          />
        </div>
        <div className="w-[130px]">
          <TextField
            id={`floor-order-${floor.id}`}
            label={t('area.admin.society.floors.order')}
            type="number"
            value={order}
            onChange={(event) => setOrder(event.target.value)}
            error={action.fieldError('sortOrder')}
          />
        </div>
        <div className="flex gap-2 pb-0.5">
          <RowButton onClick={() => setEditing(false)}>{t('shell.cancel')}</RowButton>
          <button
            type="submit"
            disabled={action.pending || !label.trim()}
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
      <span className="text-[14px] font-semibold text-ink">{floor.floorLabel}</span>
      {floor.sortOrder !== null && <span className="text-[12px] text-muted">{t('area.admin.society.floors.orderShown', { order: floor.sortOrder })}</span>}
      <Badge tone={floor.status === 'ACTIVE' ? 'positive' : 'danger'}>{t(`area.admin.society.status.${floor.status}`)}</Badge>
      <div className="ml-auto flex gap-2">
        <RowButton onClick={() => setEditing(true)}>{t('shell.edit')}</RowButton>
        {floor.status === 'ACTIVE' && (
          <RowButton tone="danger" onClick={() => onDeactivate(floor)}>
            {t('shell.deactivate')}
          </RowButton>
        )}
      </div>
    </div>
  )
}

/** Floors of the selected block. The label is free text: B2, Ground, 1st Floor, Terrace. */
export function FloorsTab({ token, blocks, blockId, onBlockChange }: {
  token: string
  blocks: Block[]
  blockId: string
  onBlockChange: (blockId: string) => void
}) {
  const { t } = useTranslation()
  const floors = useResource(blockId ? () => listFloors(token, blockId) : null, [token, blockId])
  const [label, setLabel] = useState('')
  const [order, setOrder] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const action = useAction()

  const deactivate = useDeactivate<Floor>({
    title: t('area.admin.society.floors.deactivate.title'),
    description: (floor) => t('area.admin.society.floors.deactivate.description', { label: floor.floorLabel }),
    confirmLabel: t('shell.deactivate'),
    onConfirm: async (floor, reason) => {
      await updateFloor(token, floor.id, { status: 'INACTIVE', reason })
      floors.reload()
    },
  })

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (await action.run(() => createFloor(token, blockId, { floorLabel: label.trim(), sortOrder: orderValue(order) }))) {
      setCreated(label.trim())
      setLabel('')
      setOrder('')
      floors.reload()
    }
  }

  const blockOptions = blocks.map((block) => ({
    value: block.id,
    label: block.status === 'ACTIVE' ? block.name : `${block.name} · ${t('area.admin.society.status.INACTIVE')}`,
  }))

  return (
    <div className="flex flex-col gap-4">
      <Panel title={t('area.admin.society.floors.add')} description={t('area.admin.society.floors.addDescription')}>
        {created && <SuccessNote message={t('area.admin.society.floors.created', { label: created })} onDismiss={() => setCreated(null)} />}
        <form className="flex flex-col gap-4" onSubmit={handleCreate} noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Select
              id="floor-block"
              label={t('area.admin.society.blocks.one')}
              options={blockOptions}
              placeholder={t('area.admin.society.floors.chooseBlock')}
              value={blockId}
              onChange={(event) => onBlockChange(event.target.value)}
              required
            />
            <TextField
              id="new-floor-label"
              label={t('area.admin.society.floors.label')}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              error={action.fieldError('floorLabel') ?? action.error}
              hint={t('area.admin.society.floors.labelHint')}
              placeholder={t('area.admin.society.floors.labelPlaceholder')}
              maxLength={80}
              disabled={!blockId}
              required
            />
            <TextField
              id="new-floor-order"
              label={t('area.admin.society.floors.order')}
              type="number"
              value={order}
              onChange={(event) => setOrder(event.target.value)}
              error={action.fieldError('sortOrder')}
              hint={t('area.admin.society.floors.orderHint')}
              disabled={!blockId}
            />
          </div>
          <div className="sm:w-[180px]">
            <Button type="submit" disabled={action.pending || !blockId || !label.trim()}>
              {action.pending ? t('shell.saving') : t('area.admin.society.floors.addAction')}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel title={t('area.admin.society.floors.title')}>
        {!blockId ? (
          <EmptyState icon={Layers} title={t('area.admin.society.floors.chooseFirst')} description={t('area.admin.society.floors.chooseFirstDescription')} />
        ) : floors.loading ? (
          <Skeleton />
        ) : floors.error ? (
          <ErrorState message={floors.error} onRetry={floors.reload} />
        ) : floors.data?.length ? (
          <div className="overflow-hidden rounded-xl border border-line [&>*:first-child]:border-t-0">
            {floors.data.map((floor) => (
              <FloorRow key={floor.id} floor={floor} token={token} onChanged={floors.reload} onDeactivate={deactivate.ask} />
            ))}
          </div>
        ) : (
          <EmptyState icon={Layers} title={t('area.admin.society.floors.empty.title')} description={t('area.admin.society.floors.empty.description')} />
        )}
      </Panel>
      {deactivate.dialog}
    </div>
  )
}
