import { ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { AuthUser } from '../auth/api'
import { allowed, AREAS } from '../shell/areas'
import { SyncSummary } from '../sync/SyncPage'

function greetingKey(hour: number) {
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'
}

/** The role's overview page. Every action and summary is filtered by the user's permissions. */
export function Dashboard({ user }: { user: AuthUser }) {
  const { t } = useTranslation()
  const [hour] = useState(() => new Date().getHours())
  const config = AREAS[user.role]
  const prefix = `area.${config.area}`
  const primary = allowed(user, config.primaryAction) ? config.primaryAction : null
  const stats = config.stats.filter((stat) => allowed(user, stat))
  const shortcuts = config.shortcuts.filter((shortcut) => allowed(user, shortcut))
  const title =
    config.area === 'resident'
      ? t(`shell.greeting.${greetingKey(hour)}`, { name: user.name.split(' ')[0] })
      : t(`${prefix}.title`)

  const primaryButton = primary && (
    <Link
      to={`/${config.area}/${primary.path}`}
      className="flex h-11 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-[14px] font-semibold text-white hover:bg-[#125a52] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand/30"
    >
      <Plus size={16} aria-hidden />
      {t(`${prefix}.primary.${primary.key}`)}
    </Link>
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <p className="text-[10px] font-semibold tracking-wide text-brand uppercase">{t(`${prefix}.workspace`)}</p>
          <h1 className="text-[22px] leading-7 text-ink">{title}</h1>
        </div>
        {/* Mobile moves the primary action to the bottom of the page */}
        <div className="hidden sm:block">{primaryButton}</div>
      </div>

      {stats.length > 0 && (
        <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-3" aria-label={t('shell.summary')}>
          {stats.map(({ key, icon: Icon }, index) => (
            // Mobile keeps the first two summaries, as in the design
            <li key={key} className={`flex flex-col gap-2 rounded-xl border border-line bg-white p-3.5 ${index > 1 ? 'hidden sm:flex' : ''}`}>
              <div className="flex items-center justify-between text-[11px] text-muted">
                {t(`${prefix}.stats.${key}`)}
                <Icon size={15} className="text-brand" aria-hidden />
              </div>
              {config.area === 'guard' && key === 'sync' ? (
                <p className="text-[13px] text-ink">
                  <SyncSummary />
                </p>
              ) : (
                // ponytail: no summary APIs yet; show the value from the API once each feature ships
                <>
                  <p className="text-lg text-ink">—</p>
                  <p className="text-[10px] text-muted">{t('shell.noData')}</p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {shortcuts.length > 0 && (
        <ul className="hidden gap-2.5 sm:grid sm:grid-cols-3" aria-label={t('shell.shortcuts')}>
          {shortcuts.map(({ key, path, icon: Icon }) => (
            <li key={key}>
              <Link
                to={`/${config.area}/${path}`}
                className="flex h-full min-h-[70px] items-center gap-2.5 rounded-xl border border-line bg-white px-3 py-3 hover:border-brand/40 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand/30"
              >
                <span className="flex size-[34px] shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                  <Icon size={17} aria-hidden />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13px] font-medium text-ink">{t(`${prefix}.shortcuts.${key}.label`)}</span>
                  <span className="text-[10px] leading-[13px] text-muted">{t(`${prefix}.shortcuts.${key}.description`)}</span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-3 rounded-xl border border-line bg-white p-3.5" aria-labelledby="activity-title">
        <h2 id="activity-title" className="text-[13px] text-ink">
          {t(`${prefix}.activity`)}
        </h2>
        {/* ponytail: activity feed needs the audit/visits APIs; empty state until then */}
        <p className="text-[12px] text-muted">{t('shell.noActivity')}</p>
      </section>

      {primaryButton && <div className="sm:hidden">{primaryButton}</div>}
    </div>
  )
}
