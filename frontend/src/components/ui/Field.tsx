import type { ReactNode } from 'react'

interface FieldProps {
  id: string
  label: string
  /** Shown under the control in red, and announced as the control's description */
  error?: string
  hint?: string
  required?: boolean
  children: ReactNode
}

/** Label, control and message for one form field. Pair it with `fieldProps` on the control. */
export function Field({ id, label, error, hint, required = false, children }: FieldProps) {
  return (
    <div className="flex w-full flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-semibold text-ink-soft">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-message`} className="text-[12px] font-medium text-red-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-message`} className="text-[12px] text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** The id and ARIA wiring a control inside a Field needs. */
export function fieldProps(id: string, error?: string, hint?: string) {
  return {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error || hint ? `${id}-message` : undefined,
  }
}

export const controlClass = (error?: string) =>
  `h-[46px] w-full rounded-lg border bg-white px-[13px] text-[15px] text-ink-soft outline-none transition-[border-color,box-shadow] focus:ring-3 placeholder:text-subtle ${
    error ? 'border-red-400 focus:border-red-500 focus:ring-red-500/15' : 'border-line-strong focus:border-brand focus:ring-brand/15'
  }`
