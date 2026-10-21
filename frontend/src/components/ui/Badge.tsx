import type { ReactNode } from 'react'

export type Tone = 'neutral' | 'brand' | 'positive' | 'warning' | 'danger'

const TONE: Record<Tone, string> = {
  neutral: 'bg-canvas text-muted',
  brand: 'bg-brand/10 text-brand-deep',
  positive: 'bg-emerald-50 text-emerald-800',
  warning: 'bg-amber-50 text-amber-800',
  danger: 'bg-red-50 text-red-700',
}

/** Short status word beside a record: ACTIVE, PENDING, VACANT. */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-bold tracking-wide ${TONE[tone]}`}>{children}</span>
}
