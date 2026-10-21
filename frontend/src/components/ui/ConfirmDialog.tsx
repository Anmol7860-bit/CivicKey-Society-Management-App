import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { controlClass, Field, fieldProps } from './Field'

interface ConfirmDialogProps {
  title: string
  description: string
  confirmLabel: string
  /** The API's message when the confirmed action failed */
  error?: string
  pending?: boolean
  onConfirm: (reason: string) => void
  onCancel: () => void
}

/**
 * Asks before deactivating a record, and takes the reason the server requires. The reason is kept
 * in the audit trail with the actor, never on the record, so there is nothing to show afterwards.
 */
export function ConfirmDialog({ title, description, confirmLabel, error, pending = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useTranslation()
  const id = useId()
  const [reason, setReason] = useState('')
  const tooShort = reason.trim().length < 3

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!tooShort && !pending) onConfirm(reason.trim())
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <form
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal
        aria-labelledby={`${id}-title`}
        className="flex w-full max-w-[420px] flex-col gap-3 rounded-2xl border border-line bg-white p-5 shadow-card"
      >
        <h2 id={`${id}-title`} className="text-[18px] font-bold text-ink">
          {title}
        </h2>
        <p className="text-[13px] text-muted">{description}</p>
        <Field id={`${id}-reason`} label={t('area.admin.society.reason.label')} hint={t('area.admin.society.reason.hint')} required>
          <input
            {...fieldProps(`${id}-reason`, undefined, t('area.admin.society.reason.hint'))}
            className={controlClass()}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={200}
            autoFocus
          />
        </Field>
        {error && (
          <p className="text-[13px] font-semibold text-red-700" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-11 cursor-pointer rounded-lg border border-line-strong bg-white px-4 text-[14px] font-semibold text-ink-soft hover:bg-canvas"
          >
            {t('shell.cancel')}
          </button>
          <button
            type="submit"
            disabled={tooShort || pending}
            className="h-11 cursor-pointer rounded-lg bg-red-700 px-4 text-[14px] font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
