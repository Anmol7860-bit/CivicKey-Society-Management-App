import type { SelectHTMLAttributes } from 'react'
import { controlClass, Field, fieldProps } from './Field'

interface Option {
  value: string
  label: string
  disabled?: boolean
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'id'> {
  id: string
  label: string
  options: Option[]
  /** First entry, used for "Choose a block" and the like. Omit when a value is always set. */
  placeholder?: string
  error?: string
  hint?: string
}

export function Select({ id, label, options, placeholder, error, hint, required, ...selectProps }: SelectProps) {
  return (
    <Field id={id} label={label} error={error} hint={hint} required={required}>
      <select {...fieldProps(id, error, hint)} className={`${controlClass(error)} cursor-pointer`} required={required} {...selectProps}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  )
}
