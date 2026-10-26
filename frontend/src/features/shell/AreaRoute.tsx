import { ArrowLeft, RouteOff, ShieldX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useLocation } from 'react-router'
import { ActivityPage } from '../activity/ActivityPage'
import { NotificationsPage } from '../activity/NotificationsPage'
import type { AuthUser } from '../auth/api'
import { Dashboard } from '../dashboard/Dashboard'
import { BillingPage } from '../billing/BillingPage'
import { BillsPage } from '../gate/BillsPage'
import { DailyHelpPage } from '../gate/DailyHelpPage'
import { GateLogPage } from '../gate/GateLogPage'
import { GatePage } from '../gate/GatePage'
import { VisitorRegistrationPage } from '../gate/VisitorRegistrationPage'
import { VisitorsPage } from '../gate/VisitorsPage'
import { ReportsPage } from '../billing/ReportsPage'
import { SecurityPage } from '../security/SecurityPage'
import { AddUserPage } from '../society/AddUserPage'
import { MyFlatPage } from '../society/MyFlatPage'
import { SocietyPage } from '../society/SocietyPage'
import { StaffPage } from '../staff/StaffPage'
import { SyncPage } from '../sync/SyncPage'
import { TasksPage } from '../task/TasksPage'
import { useAutoSync } from '../sync/useSync'
import { AppShell } from './AppShell'
import { allowed, AREAS, homePath } from './areas'

const AREA_NAMES = Object.values(AREAS).map((config) => config.area as string)

function AccessDenied({ user, path }: { user: AuthUser; path: string }) {
  const { t } = useTranslation()
  const role = t(`auth.login.roles.${user.role}`)

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 px-2 py-10 text-center">
      <span className="flex size-[76px] items-center justify-center rounded-full bg-red-50 text-red-600">
        <ShieldX size={36} aria-hidden />
      </span>
      <p className="rounded-full bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 uppercase">{t('shell.denied.code')}</p>
      <h1 className="max-w-[480px] text-[26px] leading-9 text-ink">{t('shell.denied.title')}</h1>
      <p className="max-w-[480px] text-[14px] leading-[23px] text-muted">{t('shell.denied.description', { role })}</p>
      <p className="flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-[12px]">
        <RouteOff size={15} className="text-red-600" aria-hidden />
        <span className="text-ink">{path}</span>
        <span className="text-red-700">{t('shell.denied.blocked', { role })}</span>
      </p>
      <Link
        to={homePath(user.role)}
        className="flex h-11 items-center gap-2 rounded-lg bg-brand px-4 text-[14px] font-semibold text-white hover:bg-[#125a52] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand/30"
      >
        <ArrowLeft size={16} aria-hidden />
        {t('shell.denied.back', { role })}
      </Link>
    </div>
  )
}

// ponytail: stands in for each destination until its feature ticket ships the real page
function ComingSoon({ title }: { title: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-[22px] leading-7 text-ink">{title}</h1>
      <p className="rounded-xl border border-line bg-white p-4 text-[13px] text-muted">{t('shell.comingSoon')}</p>
    </div>
  )
}

/** Uploads the guard's offline entries in the background on every guard page */
function AutoSync({ accessToken }: { accessToken: string }) {
  useAutoSync(accessToken)
  return null
}

/**
 * Resolves a signed-in URL: the user's own allowed pages render, another role's area or a page
 * the user lacks permission for shows Access Denied, and anything else goes to the home page.
 */
interface AreaRouteProps {
  user: AuthUser
  accessToken: string
  onLogout: () => Promise<void>
}

export function AreaRoute({ user, accessToken, onLogout }: AreaRouteProps) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const [, area = '', page = ''] = pathname.split('/')
  const config = AREAS[user.role]
  const item = area === config.area ? config.nav.find((entry) => entry.path === page) : undefined

  let content
  if (area === config.area) {
    if (!item) return <Navigate to={homePath(user.role)} replace />
    content = !allowed(user, item) ? (
      <AccessDenied user={user} path={pathname} />
    ) : item.path === config.home ? (
      <Dashboard user={user} accessToken={accessToken} />
    ) : item.key === 'addUser' ? (
      <AddUserPage accessToken={accessToken} />
    ) : item.key === 'society' ? (
      <SocietyPage user={user} accessToken={accessToken} />
    ) : item.key === 'myFlat' ? (
      <MyFlatPage accessToken={accessToken} />
    ) : item.key === 'dailyHelp' ? (
      <DailyHelpPage accessToken={accessToken} />
    ) : item.key === 'visitorRegistration' ? (
      <VisitorRegistrationPage user={user} accessToken={accessToken} />
    ) : item.key === 'passValidation' ? (
      // One screen: pass validation, staff verification and who is inside now, as the PDF has them.
      // Staff verification has no nav entry of its own; the guard reaches it here.
      <GatePage user={user} accessToken={accessToken} />
    ) : item.key === 'gate' ? (
      <GateLogPage user={user} accessToken={accessToken} />
    ) : item.key === 'visitorApproval' ? (
      <VisitorsPage accessToken={accessToken} />
    ) : item.key === 'activity' ? (
      <ActivityPage user={user} accessToken={accessToken} />
    ) : item.key === 'notifications' ? (
      <NotificationsPage user={user} accessToken={accessToken} />
    ) : item.key === 'bills' ? (
      <BillsPage accessToken={accessToken} />
    ) : item.key === 'staff' ? (
      <StaffPage user={user} accessToken={accessToken} />
    ) : item.key === 'billing' ? (
      <BillingPage user={user} accessToken={accessToken} />
    ) : item.key === 'reports' ? (
      <ReportsPage accessToken={accessToken} />
    ) : item.key === 'tasks' ? (
      <TasksPage accessToken={accessToken} />
    ) : item.key === 'security' ? (
      <SecurityPage accessToken={accessToken} />
    ) : user.role === 'GUARD' && item.key === 'sync' ? (
      <SyncPage accessToken={accessToken} />
    ) : (
      <ComingSoon title={t(`area.${config.area}.nav.${item.key}`)} />
    )
  } else if (AREA_NAMES.includes(area)) {
    content = <AccessDenied user={user} path={pathname} />
  } else {
    return <Navigate to={homePath(user.role)} replace />
  }

  return (
    <AppShell user={user} onLogout={onLogout}>
      {user.role === 'GUARD' && <AutoSync accessToken={accessToken} />}
      {content}
    </AppShell>
  )
}
