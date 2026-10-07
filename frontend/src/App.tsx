import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import type { AuthSession, AuthUser } from './features/auth/api'
import { LoginPage } from './features/auth/LoginPage'

// Role from the backend decides the area; the user never picks it
const areaByRole = { ADMIN: 'admin', RESIDENT: 'resident', GUARD: 'guard' } as const

// ponytail: placeholder shells; each area gets its own pages in its own ticket
function RoleShell({ user }: { user: AuthUser }) {
  const { t } = useTranslation()
  const area = areaByRole[user.role]

  return (
    <main className="p-6" data-area={area}>
      <h1 className="text-2xl font-bold text-ink">{t(`shell.${area}.title`)}</h1>
      <p className="text-muted">{t('shell.signedInAs', { name: user.name })}</p>
    </main>
  )
}

function App() {
  // ponytail: access token lives in memory only; session restore via /auth/refresh is its own ticket
  const [session, setSession] = useState<AuthSession | null>(null)
  const home = session ? `/${areaByRole[session.user.role]}` : '/login'

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={session ? <Navigate to={home} replace /> : <LoginPage onSignedIn={setSession} />}
        />
        {/* Only the signed-in user's own area exists; any other URL (incl. other roles' areas) redirects home */}
        {session && <Route path={home} element={<RoleShell user={session.user} />} />}
        <Route path="*" element={<Navigate to={home} replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
