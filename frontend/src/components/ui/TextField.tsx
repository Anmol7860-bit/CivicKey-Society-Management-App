import type { InputHTMLAttributes, ReactNode } from 'react'

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  id: string
  label: string
  /** Icon shown before the input */
  leading?: ReactNode
  /** Element shown after the input, e.g. a visibility toggle */
  trailing?: ReactNode
}

export function TextField({ id, label, leading, trailing, ...inputProps }: TextFieldProps) {
  return (
    <div className="flex w-full flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-semibold text-ink-soft">
        {label}
      </label>
      <div className="flex h-[46px] w-full items-center gap-2 rounded-lg border border-line-strong bg-white px-[13px] transition-[border-color,box-shadow] focus-within:border-brand focus-within:ring-3 focus-within:ring-brand/15">
        {leading}
        <input
          id={id}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-ink-soft outline-none placeholder:text-subtle"
          {...inputProps}
        />
        {trailing}
      </div>
    </div>
  )
}
