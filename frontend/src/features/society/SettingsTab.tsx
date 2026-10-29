import { DatabaseBackup, Download } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, type Tone } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import {
  downloadBackup,
  getSettings,
  listBackups,
  requestBackup,
  updateSettings,
  type BackupStatus,
} from './api'
import { Panel, RowButton, useAction } from './parts'
import { useResource } from './useResource'

const TONE: Record<BackupStatus, Tone> = {
  PENDING: 'warning',
  RUNNING: 'warning',
  READY: 'positive',
  FAILED: 'danger',
  EXPIRED: 'neutral',
}

/** The visitor types the gate can offer, in the order the guard's form shows them. */
const PURPOSES = ['GUEST', 'FOOD_DELIVERY', 'DELIVERY', 'CAB', 'DOMESTIC_HELP', 'MAINTENANCE', 'SERVICE', 'BUSINESS', 'OTHER']

const size = (bytes: number | null) => (bytes === null ? '—' : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

/**
 * The society's own choices, and the encrypted database export.
 *
 * The export is a background job, so the panel is reloaded rather than told the result: the list
 * says generating, ready or failed, and a ready link is spent the first time it is used.
 */
export function SettingsTab({ token, societyId }: { token: string; societyId: string }) {
  const { t } = useTranslation()
  const [saved, setSaved] = useState(false)
  const settings = useResource(() => getSettings(token, societyId), [token, societyId])
  const [reloads, setReloads] = useState(0)
  const backups = useResource(() => listBackups(token, societyId), [token, societyId, reloads])
  const save = useAction()
  const exportAction = useAction()
  const download = useAction()

  if (settings.loading) return <Skeleton rows={4} />
  if (settings.error) return <ErrorState message={settings.error} onRetry={settings.reload} />
  const current = settings.data!

  /** Every settings change goes the same way: save, say so, read back what was stored. */
  async function change(body: Parameters<typeof updateSettings>[2]) {
    setSaved(false)
    if (await save.run(() => updateSettings(token, societyId, body))) {
      setSaved(true)
      settings.reload()
    }
  }

  /** An empty stored list means the gate offers all of them, so unticking the last one is refused. */
  function togglePurpose(purpose: string, offered: boolean) {
    const chosen = current.visitorPurposes.length ? current.visitorPurposes : PURPOSES
    const next = offered ? [...chosen, purpose] : chosen.filter((value) => value !== purpose)
    if (next.length === 0) return
    void change({ visitorPurposes: next.length === PURPOSES.length ? [] : PURPOSES.filter((value) => next.includes(value)) })
  }

  async function handleExport() {
    if (await exportAction.run(() => requestBackup(token, societyId))) setReloads((n) => n + 1)
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel title={t('area.admin.society.settings.title')} description={t('area.admin.society.settings.description')}>
        {saved && <SuccessNote message={t('area.admin.society.settings.saved')} onDismiss={() => setSaved(false)} />}
        {save.error && <ErrorState message={save.error} />}
        <label className="flex items-start gap-3 rounded-xl border border-line p-3.5">
          <input
            type="checkbox"
            checked={current.idRequired}
            onChange={(event) => void change({ idRequired: event.target.checked })}
            disabled={save.pending}
            className="mt-0.5 size-4 accent-[var(--color-brand)]"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-[14px] font-semibold text-ink">{t('area.admin.society.settings.idRequired')}</span>
            <span className="text-[12px] text-muted">{t('area.admin.society.settings.idRequiredHint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-xl border border-line p-3.5">
          <input
            type="checkbox"
            checked={current.leaveAtGateAllowed}
            onChange={(event) => void change({ leaveAtGateAllowed: event.target.checked })}
            disabled={save.pending}
            className="mt-0.5 size-4 accent-[var(--color-brand)]"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-[14px] font-semibold text-ink">{t('area.admin.society.settings.leaveAtGate')}</span>
            <span className="text-[12px] text-muted">{t('area.admin.society.settings.leaveAtGateHint')}</span>
          </span>
        </label>
        <fieldset className="flex flex-col gap-2 border-0 p-0">
          <legend className="text-[11px] font-semibold text-ink-soft">{t('area.admin.society.settings.purposes')}</legend>
          <p className="m-0 text-[12px] text-muted">{t('area.admin.society.settings.purposesHint')}</p>
          <div className="flex flex-wrap gap-2">
            {PURPOSES.map((purpose) => {
              const offered = current.visitorPurposes.length === 0 || current.visitorPurposes.includes(purpose)
              return (
                <label key={purpose} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px] text-ink">
                  <input
                    type="checkbox"
                    checked={offered}
                    onChange={(event) => togglePurpose(purpose, event.target.checked)}
                    disabled={save.pending}
                    className="size-4 accent-[var(--color-brand)]"
                  />
                  {t(`area.guard.purposes.${purpose}`)}
                </label>
              )
            })}
          </div>
        </fieldset>
        <div className="max-w-[260px]">
          <TextField
            id="society-validity-hours"
            label={t('area.admin.society.settings.validityHours')}
            hint={t('area.admin.society.settings.validityHoursHint')}
            type="number"
            min={1}
            max={336}
            defaultValue={current.visitValidityHours}
            onBlur={(event) => {
              const hours = Number(event.target.value)
              if (hours >= 1 && hours <= 336 && hours !== current.visitValidityHours) void change({ visitValidityHours: hours })
            }}
            error={save.fieldError('visitValidityHours')}
          />
        </div>
        <div className="max-w-[260px]">
          <TextField
            id="society-photo-retention"
            label={t('area.admin.society.settings.photoRetentionDays')}
            hint={t('area.admin.society.settings.photoRetentionDaysHint')}
            type="number"
            min={7}
            max={1095}
            defaultValue={current.photoRetentionDays}
            onBlur={(event) => {
              const days = Number(event.target.value)
              if (days >= 7 && days <= 1095 && days !== current.photoRetentionDays) void change({ photoRetentionDays: days })
            }}
            error={save.fieldError('photoRetentionDays')}
          />
        </div>
        <div className="max-w-[260px]">
          <TextField
            id="society-timezone"
            label={t('area.admin.society.settings.timezone')}
            value={current.timezone}
            onChange={(event) => void change({ timezone: event.target.value.trim() })}
            error={save.fieldError('timezone')}
            maxLength={80}
          />
        </div>
      </Panel>

      <Panel title={t('area.admin.society.backups.title')} description={t('area.admin.society.backups.description')}>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleExport} disabled={exportAction.pending}>
            <DatabaseBackup size={15} aria-hidden />
            {exportAction.pending ? t('area.admin.society.backups.starting') : t('area.admin.society.backups.export')}
          </Button>
          <RowButton onClick={() => setReloads((n) => n + 1)}>{t('area.admin.society.backups.refresh')}</RowButton>
        </div>
        {exportAction.error && <ErrorState message={exportAction.error} />}
        {download.error && <ErrorState message={download.error} />}

        {backups.loading ? (
          <Skeleton rows={2} />
        ) : (
          <div className="overflow-auto rounded-xl border border-line">
            <table className="w-full border-collapse text-[13px]">
              <thead className="bg-canvas">
                <tr>
                  {['requested', 'status', 'size', 'link'].map((column) => (
                    <th key={column} className="px-3 py-2 text-left text-[11px] font-bold tracking-wide text-muted uppercase">
                      {t(`area.admin.society.backups.columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(backups.data ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-3 text-[13px] text-muted">
                      {t('area.admin.society.backups.empty')}
                    </td>
                  </tr>
                ) : (
                  (backups.data ?? []).map((job) => (
                    <tr key={job.id} className="border-t border-line">
                      <td className="px-3 py-2 text-ink">{new Date(job.createdAt).toLocaleString()}</td>
                      <td className="px-3 py-2">
                        <Badge tone={TONE[job.status]}>{t(`area.admin.society.backups.statuses.${job.status}`)}</Badge>
                        {job.errorCode && <span className="ml-2 text-[12px] text-red-700">{job.errorCode}</span>}
                      </td>
                      <td className="px-3 py-2 text-muted">{size(job.byteSize)}</td>
                      <td className="px-3 py-2">
                        {job.status === 'READY' ? (
                          <button
                            type="button"
                            onClick={() => void download.run(() => downloadBackup(token, job.id))}
                            disabled={download.pending}
                            className="flex items-center gap-1.5 rounded text-[12px] font-semibold text-brand hover:underline"
                          >
                            <Download size={13} aria-hidden />
                            {t('area.admin.society.backups.download')}
                          </button>
                        ) : (
                          <span className="text-[12px] text-muted">
                            {job.downloadedAt ? t('area.admin.society.backups.used') : '—'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="m-0 text-[12px] text-muted">{t('area.admin.society.backups.note')}</p>
      </Panel>
    </div>
  )
}
