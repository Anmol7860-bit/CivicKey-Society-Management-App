import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { Button } from './components/ui/Button'
import { ApiError, logout, refresh, type AuthSession, type AuthUser } from './features/auth/api'
import { LoginPage } from './features/auth/LoginPage'

// Role from the backend decides the area; the user never picks it
const areaByRole = { ADMIN: 'admin', RESIDENT: 'resident', GUARD: 'guard' } as const

/** Refresh this long before the access token expires, so API calls never carry an expired one */
const REFRESH_EARLY_SECONDS = 60
/** After a network failure, keep the session and retry the refresh this often */
const REFRESH_RETRY_MS = 30_000

// ponytail: placeholder shells; each area gets its own pages in its own ticket
function RoleShell({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const { t } = useTranslation()
  const [pending, setPending] = useState(false)
  const area = areaByRole[user.role]

  return (
    <main className="flex flex-col gap-4 p-6" data-area={area}>
      <div>
        <h1 className="text-2xl font-bold text-ink">{t(`shell.${area}.title`)}</h1>
        <p className="text-muted">{t('shell.signedInAs', { name: user.name })}</p>
      </div>
      <div className="w-40">
        <Button
          disabled={pending}
          onClick={() => {
            setPending(true)
            void onLogout()
          }}
        >
          {pending ? t('shell.loggingOut') : t('shell.logout')}
        </Button>
      </div>
    </main>
  )
}

function App() {
  const { t } = useTranslation()
  // The access token lives in memory only; the httpOnly refresh cookie restores it after a reload
  const [session, setSession] = useState<AuthSession | null>(null)
  const [restoring, setRestoring] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    refresh()
      .then((restored) => active && setSession(restored))
      .catch(() => {}) // No valid refresh cookie: show the login page
      .finally(() => active && setRestoring(false))
    return () => {
      active = false
    }
  }, [])

  // Swap the access token for a fresh one shortly before it expires
  useEffect(() => {
    if (!session) return
    let active = true
    let timer: number

    const run = () =>
      refresh().then(
        (next) => active && setSession(next),
        (error) => {
          if (!active) return
          if (error instanceof ApiError) {
            // Expired, revoked or reused session: the user must sign in again
            setSession(null)
            setNotice(t('auth.session.expired'))
          } else {
            timer = window.setTimeout(run, REFRESH_RETRY_MS)
          }
        },
      )
    timer = window.setTimeout(run, Math.max(session.expiresIn - REFRESH_EARLY_SECONDS, 5) * 1000)

    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [session, t])

  async function handleLogout() {
    try {
      await logout(session!.accessToken)
    } catch {
      // ponytail: signs out locally even if the server call fails (offline); the server session then
      // lives until it expires. Add a retry queue if offline logout must revoke immediately.
    }
    setNotice(null)
    setSession(null)
  }

  function handleSignedIn(next: AuthSession) {
    setNotice(null)
    setSession(next)
  }

  if (restoring) return null

  const home = session ? `/${areaByRole[session.user.role]}` : '/login'

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={session ? <Navigate to={home} replace /> : <LoginPage onSignedIn={handleSignedIn} notice={notice} />}
        />
        {/* Only the signed-in user's own area exists; any other URL (incl. other roles' areas) redirects home */}
        {session && <Route path={home} element={<RoleShell user={session.user} onLogout={handleLogout} />} />}
        <Route path="*" element={<Navigate to={home} replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
