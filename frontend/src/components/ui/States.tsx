import { CircleAlert, Inbox, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'

/** Keeps the shape of a list while it loads, so nothing jumps when the rows arrive. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2 p-4" role="status" aria-busy>
      <span className="sr-only">{t('shell.loading')}</span>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="h-[42px] animate-pulse rounded-lg bg-canvas" />
      ))}
    </div>
  )
}

/** Nothing here yet: names the next step rather than showing an empty table. */
export function EmptyState({ icon: Icon = Inbox, title, description, action }: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-strong px-6 py-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-brand/10 text-brand">
        <Icon size={22} aria-hidden />
      </span>
      <h3 className="text-[17px] font-bold text-ink">{title}</h3>
      {description && <p className="max-w-[340px] text-[13px] text-muted">{description}</p>}
      {action}
    </div>
  )
}

/** A failure with nowhere else to sit. Field errors stay beside their field instead. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4" role="alert">
      <CircleAlert size={18} className="mt-0.5 shrink-0 text-red-700" aria-hidden />
      <div className="flex flex-col items-start gap-2">
        <p className="text-[13px] font-semibold text-red-800">{message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="h-9 cursor-pointer rounded-lg border border-red-300 bg-white px-3 text-[13px] font-semibold text-red-800 hover:bg-red-100"
          >
            {t('shell.retry')}
          </button>
        )}
      </div>
    </div>
  )
}

/** Confirmation of a save, dismissed by the next action. */
export function SuccessNote({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3 rounded-xl border border-brand/30 bg-brand/10 p-3" role="status">
      <p className="text-[13px] font-semibold text-brand-deep">{message}</p>
      <button type="button" onClick={onDismiss} className="ml-auto cursor-pointer text-[13px] font-semibold text-brand-deep underline">
        {t('shell.dismiss')}
      </button>
    </div>
  )
}
