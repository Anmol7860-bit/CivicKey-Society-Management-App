import { LogOut, Menu, RefreshCw, ShieldCheck, X, Bell } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router'
import buildingOnBrand from '../../assets/icons/building-2-on-brand.svg'
import type { AuthUser } from '../auth/api'
import { useLiveNotifications, useNotifications } from '../notification/useNotifications'
import { SyncSummary } from '../sync/SyncPage'
import { allowed, AREAS } from './areas'

interface ShellProps {
  user: AuthUser
  accessToken: string
  onLogout: () => Promise<void>
  children: ReactNode
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

function RoleBadge({ user }: { user: AuthUser }) {
  const { t } = useTranslation()
  return (
    <span className="flex h-[25px] items-center gap-1.5 rounded-full bg-brand/10 px-2.5 text-xs font-semibold text-brand">
      <ShieldCheck size={13} aria-hidden />
      {t(`auth.login.roles.${user.role}`)}
    </span>
  )
}

/** Only the destinations this user may open are rendered; the rest never reach the DOM. */
function Navigation({ user, onNavigate }: { user: AuthUser; onNavigate?: () => void }) {
  const { t } = useTranslation()
  const config = AREAS[user.role]

  return (
    <nav aria-label={t('shell.navigation')} className="flex flex-col gap-2">
      <p className="mb-1 text-[10px] font-semibold tracking-wide text-subtle uppercase">
        {t('shell.allowed', { role: t(`auth.login.roles.${user.role}`) })}
      </p>
      {config.nav
        .filter((item) => allowed(user, item))
        .map(({ key, path, icon: Icon }) => (
          <NavLink
            key={key}
            to={`/${config.area}/${path}`}
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex h-10 items-center gap-2 rounded-lg px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
                isActive ? 'bg-brand font-semibold text-white' : 'text-white/80 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            <Icon size={16} aria-hidden />
            {t(`area.${config.area}.nav.${key}`)}
          </NavLink>
        ))}
    </nav>
  )
}

function LogoutButton({ onLogout, className }: { onLogout: () => Promise<void>; className: string }) {
  const { t } = useTranslation()
  const [pending, setPending] = useState(false)
  return (
    <button
      type="button"
      disabled={pending}
      className={`flex cursor-pointer items-center gap-2 rounded-lg text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-70 ${className}`}
      onClick={() => {
        setPending(true)
        void onLogout()
      }}
    >
      <LogOut size={16} aria-hidden />
      {pending ? t('shell.loggingOut') : t('shell.logout')}
    </button>
  )
}

export function AppShell({ user, accessToken, onLogout, children }: ShellProps) {
  const { t } = useTranslation()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const config = AREAS[user.role]
  const notifications = config.nav.find((item) => item.key === 'notifications')
  // The shell is on every signed-in page, so the live connection and the unread count live here
  useLiveNotifications(accessToken)
  const { unread } = useNotifications(accessToken)

  return (
    <div className="flex min-h-dvh flex-col" data-area={config.area}>
      <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between border-b border-line bg-white px-[18px] sm:px-6">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-brand">
            <img src={buildingOnBrand} alt="" width={18} height={18} />
          </div>
          <span className="text-[15px] font-bold text-ink">{t('brand.name')}</span>
        </div>

        <div className="flex items-center gap-4">
          {/* A guard always sees whether gate entries are still waiting on this device */}
          {config.area === 'guard' && (
            <NavLink
              to="/guard/sync"
              className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:text-ink"
            >
              <RefreshCw size={13} aria-hidden />
              <SyncSummary compact />
            </NavLink>
          )}
          <RoleBadge user={user} />
          <a href="/help" className="hidden rounded text-[13px] text-muted hover:text-ink sm:inline">
            {t('shell.help')}
          </a>
          {/* Only roles with a notifications destination get the bell */}
          {notifications && allowed(user, notifications) && (
            <NavLink
              to={`/${config.area}/${notifications.path}`}
              aria-label={
                unread > 0
                  ? t('shell.notificationsUnread', { count: unread })
                  : t(`area.${config.area}.nav.notifications`)
              }
              className="relative hidden rounded text-muted hover:text-ink sm:inline"
            >
              <Bell size={18} aria-hidden />
              {unread > 0 && (
                <span className="absolute -top-1.5 -right-2 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </NavLink>
          )}
          <details className="relative hidden sm:block">
            <summary
              aria-label={t('shell.account')}
              className="flex size-[30px] cursor-pointer list-none items-center justify-center rounded-full border-2 border-brand/40 bg-brand/10 text-[11px] font-semibold text-brand [&::-webkit-details-marker]:hidden"
            >
              {initials(user.name)}
            </summary>
            <div className="absolute right-0 mt-2 flex w-56 flex-col gap-1 rounded-xl border border-line bg-white p-2 shadow-card">
              <p className="px-2 py-1.5 text-[13px] text-muted">{t('shell.signedInAs', { name: user.name })}</p>
              <LogoutButton onLogout={onLogout} className="h-9 px-2 text-ink hover:bg-canvas" />
            </div>
          </details>
          <button
            type="button"
            aria-label={t('shell.openMenu')}
            aria-expanded={drawerOpen}
            className="cursor-pointer rounded text-ink-soft desk:hidden"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu size={22} aria-hidden />
          </button>
        </div>
      </header>

      <div className="flex flex-1">
        {/* Desktop: persistent navigation */}
        <aside className="hidden w-[196px] shrink-0 bg-ink p-4 desk:block">
          <Navigation user={user} />
        </aside>

        <main className="min-w-0 flex-1 bg-canvas p-[18px] sm:p-5">{children}</main>
      </div>

      {/* Tablet and mobile: the same filtered navigation in a drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-30 desk:hidden" onKeyDown={(event) => event.key === 'Escape' && setDrawerOpen(false)}>
          <div className="absolute inset-0 bg-ink/40" onClick={() => setDrawerOpen(false)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('shell.navigation')}
            className="absolute inset-y-0 left-0 flex w-[260px] flex-col justify-between bg-ink p-4"
          >
            <div className="flex flex-col gap-4">
              <button
                type="button"
                aria-label={t('shell.closeMenu')}
                autoFocus
                className="cursor-pointer self-end rounded text-white/80 hover:text-white"
                onClick={() => setDrawerOpen(false)}
              >
                <X size={22} aria-hidden />
              </button>
              <Navigation user={user} onNavigate={() => setDrawerOpen(false)} />
            </div>
            <div className="flex flex-col gap-2 border-t border-white/15 pt-3">
              <p className="px-3 text-[13px] text-white/70">{t('shell.signedInAs', { name: user.name })}</p>
              <LogoutButton onLogout={onLogout} className="h-10 px-3 text-white hover:bg-white/10" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
