import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, login, type AuthSession } from './api'
import { AuthLayout } from './components/AuthLayout'
import { LoginForm, type LoginFormValues } from './components/LoginForm'

export function LoginPage({ onSignedIn }: { onSignedIn: (session: AuthSession) => void }) {
  const { t } = useTranslation()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // State updates are async, so a fast double submit could slip past `pending`
  const inFlight = useRef(false)

  async function handleSubmit(values: LoginFormValues) {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError(null)
    try {
      onSignedIn(await login(values))
    } catch (err) {
      setError(errorMessage(err, t, values))
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return (
    <AuthLayout>
      <LoginForm onSubmit={handleSubmit} pending={pending} error={error} />
    </AuthLayout>
  )
}

function errorMessage(err: unknown, t: ReturnType<typeof useTranslation>['t'], values: LoginFormValues) {
  if (!(err instanceof ApiError)) return t('auth.login.errors.network')
  switch (err.code) {
    case 'INVALID_CREDENTIALS':
      return t('auth.login.errors.invalidCredentials')
    case 'USER_INACTIVE':
      return t('auth.login.errors.inactive')
    case 'ROLE_MISMATCH':
      return t('auth.login.errors.roleMismatch', { role: t(`auth.login.roles.${values.role}`) })
    case 'VALIDATION_ERROR':
      return t('auth.login.errors.validation')
    case 'TOO_MANY_REQUESTS':
      return t('auth.login.errors.tooManyRequests', { minutes: Math.ceil((err.retryAfterSeconds ?? 60) / 60) })
    default:
      return t('auth.login.errors.generic')
  }
}
