import { Building2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { EmptyState, ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import { createBlock, listBlocks, updateBlock, type Block } from './api'
import { Panel, RowButton, useAction, useDeactivate } from './parts'
import { useResource } from './useResource'

function BlockRow({ block, token, onChanged, onDeactivate }: {
  block: Block
  token: string
  onChanged: () => void
  onDeactivate: (block: Block) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(block.name)
  const [editing, setEditing] = useState(false)
  const action = useAction()

  async function handleRename(event: FormEvent) {
    event.preventDefault()
    if (await action.run(() => updateBlock(token, block.id, { name }))) {
      setEditing(false)
      onChanged()
    }
  }

  if (editing) {
    return (
      <form onSubmit={handleRename} className="flex flex-wrap items-end gap-3 border-t border-line px-4 py-3" noValidate>
        <div className="min-w-[200px] flex-1">
          <TextField
            id={`block-name-${block.id}`}
            label={t('area.admin.society.blocks.name')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={action.fieldError('name') ?? action.error}
            maxLength={64}
            autoFocus
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
      <span className="text-[14px] font-semibold text-ink">{block.name}</span>
      <Badge tone={block.status === 'ACTIVE' ? 'positive' : 'danger'}>{t(`area.admin.society.status.${block.status}`)}</Badge>
      <div className="ml-auto flex gap-2">
        <RowButton onClick={() => setEditing(true)}>{t('shell.rename')}</RowButton>
        {block.status === 'ACTIVE' && (
          <RowButton tone="danger" onClick={() => onDeactivate(block)}>
            {t('shell.deactivate')}
          </RowButton>
        )}
      </div>
    </div>
  )
}

/** Blocks of the society: list, create, rename and deactivate. */
export function BlocksTab({ token, societyId }: { token: string; societyId: string }) {
  const { t } = useTranslation()
  const blocks = useResource(() => listBlocks(token, societyId), [token, societyId])
  const [name, setName] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const action = useAction()

  const deactivate = useDeactivate<Block>({
    title: t('area.admin.society.blocks.deactivate.title'),
    description: (block) => t('area.admin.society.blocks.deactivate.description', { name: block.name }),
    confirmLabel: t('shell.deactivate'),
    onConfirm: async (block, reason) => {
      await updateBlock(token, block.id, { status: 'INACTIVE', reason })
      blocks.reload()
    },
  })

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (await action.run(() => createBlock(token, societyId, { name: name.trim() }))) {
      setCreated(name.trim())
      setName('')
      blocks.reload()
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel title={t('area.admin.society.blocks.add')} description={t('area.admin.society.blocks.addDescription')}>
        {created && <SuccessNote message={t('area.admin.society.blocks.created', { name: created })} onDismiss={() => setCreated(null)} />}
        <form className="flex flex-wrap items-end gap-3" onSubmit={handleCreate} noValidate>
          <div className="min-w-[220px] flex-1">
            <TextField
              id="new-block-name"
              label={t('area.admin.society.blocks.name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              error={action.fieldError('name') ?? action.error}
              placeholder={t('area.admin.society.blocks.namePlaceholder')}
              maxLength={64}
              required
            />
          </div>
          <div className="w-[160px] pb-0.5">
            <Button type="submit" disabled={action.pending || !name.trim()}>
              {action.pending ? t('shell.saving') : t('area.admin.society.blocks.addAction')}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel title={t('area.admin.society.blocks.title')}>
        {blocks.loading ? (
          <Skeleton />
        ) : blocks.error ? (
          <ErrorState message={blocks.error} onRetry={blocks.reload} />
        ) : blocks.data?.length ? (
          <div className="overflow-hidden rounded-xl border border-line [&>*:first-child]:border-t-0">
            {blocks.data.map((block) => (
              <BlockRow key={block.id} block={block} token={token} onChanged={blocks.reload} onDeactivate={deactivate.ask} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Building2}
            title={t('area.admin.society.blocks.empty.title')}
            description={t('area.admin.society.blocks.empty.description')}
          />
        )}
      </Panel>
      {deactivate.dialog}
    </div>
  )
}
