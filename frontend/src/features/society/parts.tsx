import { useCallback, useState, type ReactNode } from 'react'
import { ApiError } from '../auth/api'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'

/** White card used for every section of the Society & users page. */
export function Panel({ title, description, action, children }: {
  title?: string
  description?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-white p-5 shadow-card">
      {(title || action) && (
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {title && <h2 className="text-[17px] font-bold text-ink">{title}</h2>}
            {description && <p className="text-[13px] text-muted">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

/** Form grid: one column on a phone, three on a desktop. */
export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
}

export interface Tab {
  key: string
  label: string
}

/** In-page tabs; the page stays at the single /admin/society destination. */
export function Tabs({ tabs, active, onSelect }: { tabs: Tab[]; active: string; onSelect: (key: string) => void }) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1 rounded-xl border border-line bg-white p-1">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={tab.key === active}
          onClick={() => onSelect(tab.key)}
          className={`h-10 cursor-pointer rounded-lg px-3.5 text-[13px] font-semibold transition-colors ${
            tab.key === active ? 'bg-brand text-white' : 'text-ink-soft hover:bg-canvas'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

export interface Action {
  pending: boolean
  /** The API's message when it belongs to no particular field */
  error: string | undefined
  /** The 422 message for one field, or undefined */
  fieldError: (field: string) => string | undefined
  /** Runs the call; resolves true when it succeeded. Ignored while one is already running. */
  run: (call: () => Promise<unknown>) => Promise<boolean>
  clear: () => void
}

/**
 * Runs one write at a time and keeps its failure. A second submit while the first is in flight is
 * ignored, which is what stops a double-click creating two blocks.
 */
export function useAction(): Action {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<ApiError | Error>()

  const run = useCallback(
    async (call: () => Promise<unknown>) => {
      if (pending) return false
      setPending(true)
      setFailure(undefined)
      try {
        await call()
        return true
      } catch (error) {
        setFailure(error instanceof Error ? error : new Error(String(error)))
        return false
      } finally {
        setPending(false)
      }
    },
    [pending],
  )

  const fields = failure instanceof ApiError ? failure.fields : []
  return {
    pending,
    // A validation failure is shown beside its field, unless the server named no field we render
    error: failure && !(failure instanceof ApiError && failure.code === 'VALIDATION_ERROR' && fields.length) ? failure.message : undefined,
    fieldError: (field: string) => fields.find((issue) => issue.field === field)?.message,
    run,
    clear: useCallback(() => setFailure(undefined), []),
  }
}

/**
 * The deactivation confirmation every record needs: the server refuses an INACTIVE change without
 * a reason, so the dialog collects one and the call only closes when it succeeded.
 */
export function useDeactivate<T>({ title, description, confirmLabel, onConfirm }: {
  title: string
  description: (row: T) => string
  confirmLabel: string
  onConfirm: (row: T, reason: string) => Promise<unknown>
}) {
  const [target, setTarget] = useState<T | null>(null)
  const action = useAction()

  const close = () => {
    setTarget(null)
    action.clear()
  }

  return {
    ask: (row: T) => setTarget(row),
    dialog: target && (
      <ConfirmDialog
        title={title}
        description={description(target)}
        confirmLabel={confirmLabel}
        error={action.error ?? action.fieldError('reason')}
        pending={action.pending}
        onConfirm={async (reason) => {
          if (await action.run(() => onConfirm(target, reason))) close()
        }}
        onCancel={close}
      />
    ),
  }
}

/** Secondary button used for row actions: Rename, Deactivate, Cancel. */
export function RowButton({ onClick, tone = 'normal', children, disabled }: {
  onClick: () => void
  tone?: 'normal' | 'danger'
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-9 cursor-pointer rounded-lg border px-3 text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
        tone === 'danger' ? 'border-red-200 bg-white text-red-700 hover:bg-red-50' : 'border-line-strong bg-white text-ink-soft hover:bg-canvas'
      }`}
    >
      {children}
    </button>
  )
}
