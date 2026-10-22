import { DoorOpen } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import { createGate, listGates, updateGate, type Gate, type GateUse } from './api'
import { Panel, RowButton, useAction, useDeactivate } from './parts'
import { useResource } from './useResource'

const USES: GateUse[] = ['VISITORS_AND_RESIDENTS', 'VISITORS_ONLY', 'RESIDENTS_ONLY', 'SERVICE_AND_DELIVERY']

function GateRow({ gate, token, onChanged, onDeactivate }: {
  gate: Gate
  token: string
  onChanged: () => void
  onDeactivate: (gate: Gate) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(gate.name)
  const [usedFor, setUsedFor] = useState<GateUse>(gate.usedFor)
  const [editing, setEditing] = useState(false)
  const action = useAction()

  async function handleSave(event: FormEvent) {
    event.preventDefault()
    if (await action.run(() => updateGate(token, gate.id, { name: name.trim(), usedFor }))) {
      setEditing(false)
      onChanged()
    }
  }

  if (editing) {
    return (
      <form onSubmit={handleSave} className="flex flex-wrap items-end gap-3 border-t border-line px-4 py-3" noValidate>
        <div className="w-[200px]">
          <TextField
            id={`gate-name-${gate.id}`}
            label={t('area.admin.society.gates.name')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={action.fieldError('name') ?? action.error}
            maxLength={64}
            autoFocus
          />
        </div>
        <div className="w-[230px]">
          <Select
            id={`gate-use-${gate.id}`}
            label={t('area.admin.society.gates.usedFor')}
            options={USES.map((value) => ({ value, label: t(`area.admin.society.gates.uses.${value}`) }))}
            value={usedFor}
            onChange={(event) => setUsedFor(event.target.value as GateUse)}
          />
        </div>
        <div className="flex gap-2 pb-0.5">
          <RowButton onClick={() => setEditing(false)}>{t('shell.cancel')}</RowButton>
          <button
            type="submit"
            disabled={action.pending || !name.trim()}
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
      <span className="text-[14px] font-semibold text-ink">{gate.name}</span>
      <span className="text-[12px] text-muted">{t(`area.admin.society.gates.uses.${gate.usedFor}`)}</span>
      <Badge tone={gate.status === 'ACTIVE' ? 'positive' : 'danger'}>{t(`area.admin.society.status.${gate.status}`)}</Badge>
      <div className="ml-auto flex gap-2">
        <RowButton onClick={() => setEditing(true)}>{t('shell.edit')}</RowButton>
        {gate.status === 'ACTIVE' && (
          <RowButton tone="danger" onClick={() => onDeactivate(gate)}>
            {t('shell.deactivate')}
          </RowButton>
        )}
      </div>
    </div>
  )
}

/** Where people enter and leave. A guard is posted to a gate, and every entry records one. */
export function GatesTab({ token, societyId }: { token: string; societyId: string }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [usedFor, setUsedFor] = useState<GateUse>('VISITORS_AND_RESIDENTS')
  const [created, setCreated] = useState<string | null>(null)
  const action = useAction()
  const gates = useResource(() => listGates(token, societyId), [token, societyId])

  const deactivate = useDeactivate<Gate>({
    title: t('area.admin.society.gates.deactivate.title'),
    description: (gate) => t('area.admin.society.gates.deactivate.description', { name: gate.name }),
    confirmLabel: t('shell.deactivate'),
    onConfirm: async (gate, reason) => {
      await updateGate(token, gate.id, { status: 'INACTIVE', reason })
      gates.reload()
    },
  })

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (await action.run(() => createGate(token, societyId, { name: name.trim(), usedFor }))) {
      setCreated(name.trim())
      setName('')
      gates.reload()
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel title={t('area.admin.society.gates.title')} description={t('area.admin.society.gates.description')}>
        {created && <SuccessNote message={t('area.admin.society.gates.created', { name: created })} onDismiss={() => setCreated(null)} />}
        <form className="flex flex-wrap items-end gap-3" onSubmit={handleCreate} noValidate>
          <div className="min-w-[200px] flex-1">
            <TextField
              id="new-gate-name"
              label={t('area.admin.society.gates.name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              error={action.fieldError('name') ?? action.error}
              placeholder={t('area.admin.society.gates.namePlaceholder')}
              maxLength={64}
              required
            />
          </div>
          <div className="min-w-[230px] flex-1">
            <Select
              id="new-gate-use"
              label={t('area.admin.society.gates.usedFor')}
              options={USES.map((value) => ({ value, label: t(`area.admin.society.gates.uses.${value}`) }))}
              value={usedFor}
              onChange={(event) => setUsedFor(event.target.value as GateUse)}
            />
          </div>
          <div className="w-[160px]">
            <Button type="submit" disabled={action.pending || !name.trim()}>
              {action.pending ? t('shell.saving') : t('area.admin.society.gates.add')}
            </Button>
          </div>
        </form>

        {gates.loading ? (
          <Skeleton rows={2} />
        ) : gates.error ? (
          <ErrorState message={gates.error} onRetry={gates.reload} />
        ) : gates.data?.length ? (
          <div className="overflow-hidden rounded-xl border border-line [&>*:first-child]:border-t-0">
            {gates.data.map((gate) => (
              <GateRow key={gate.id} gate={gate} token={token} onChanged={gates.reload} onDeactivate={deactivate.ask} />
            ))}
          </div>
        ) : (
          <EmptyState icon={DoorOpen} title={t('area.admin.society.gates.empty.title')} description={t('area.admin.society.gates.empty.description')} />
        )}
      </Panel>
      {deactivate.dialog}
    </div>
  )
}
