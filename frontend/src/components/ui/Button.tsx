import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  icon?: ReactNode
  children: ReactNode
}

/** Primary full-width action button from the CivicKey design. */
export function Button({ icon, children, type = 'button', ...buttonProps }: ButtonProps) {
  return (
    <button
      type={type}
      className="flex h-[46px] w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-transparent bg-brand px-[18px] text-[15px] font-semibold text-white transition-colors hover:bg-[#125a52] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand/30 active:bg-[#10524b] disabled:cursor-not-allowed disabled:opacity-70"
      {...buttonProps}
    >
      {icon}
      {children}
    </button>
  )
}
