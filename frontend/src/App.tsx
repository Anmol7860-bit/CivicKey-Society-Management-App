import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { ApiError, logout, refresh, type AuthSession } from './features/auth/api'
import { LoginPage } from './features/auth/LoginPage'
import { homePath } from './features/shell/areas'
import { AreaRoute } from './features/shell/AreaRoute'

/** Refresh this long before the access token expires, so API calls never carry an expired one */
const REFRESH_EARLY_SECONDS = 60
/** After a network failure, keep the session and retry the refresh this often */
const REFRESH_RETRY_MS = 30_000

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

  const home = session ? homePath(session.user.role) : '/login'

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={session ? <Navigate to={home} replace /> : <LoginPage onSignedIn={handleSignedIn} notice={notice} />}
        />
        {/* AreaRoute shows Access Denied for other roles' areas and pages the user lacks permission for */}
        <Route
          path="*"
          element={session ? <AreaRoute user={session.user} accessToken={session.accessToken} onLogout={handleLogout} /> : <Navigate to={home} replace />}
        />
      </Routes>
    </BrowserRouter>
  )
}

export default App
