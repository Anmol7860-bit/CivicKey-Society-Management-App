import type { InputHTMLAttributes, ReactNode } from 'react'
import { Field, fieldProps } from './Field'

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  id: string
  label: string
  /** Icon shown before the input */
  leading?: ReactNode
  /** Element shown after the input, e.g. a visibility toggle */
  trailing?: ReactNode
  /** Shown under the input in red; also marks it invalid */
  error?: string
  hint?: string
}

export function TextField({ id, label, leading, trailing, error, hint, required, ...inputProps }: TextFieldProps) {
  return (
    <Field id={id} label={label} error={error} hint={hint} required={required}>
      <div
        className={`flex h-[46px] w-full items-center gap-2 rounded-lg border bg-white px-[13px] transition-[border-color,box-shadow] focus-within:ring-3 ${
          error
            ? 'border-red-400 focus-within:border-red-500 focus-within:ring-red-500/15'
            : 'border-line-strong focus-within:border-brand focus-within:ring-brand/15'
        }`}
      >
        {leading}
        <input
          {...fieldProps(id, error, hint)}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-ink-soft outline-none placeholder:text-subtle"
          required={required}
          {...inputProps}
        />
        {trailing}
      </div>
    </Field>
  )
}
