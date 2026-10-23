import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import keyRoundIcon from '../../assets/icons/lock-keyhole.svg'
import smartphoneIcon from '../../assets/icons/smartphone.svg'
import { Button } from '../../components/ui/Button'
import { TextField } from '../../components/ui/TextField'
import { ApiError, forgotPassword, setPassword } from './api'
import { AuthLayout } from './components/AuthLayout'
import { isValidPhone, normalizePhone, formatPhone, COUNTRY_CODE } from './phone'

/** Mirrors the backend rule, so the obvious mistakes are caught before a round trip. */
const isStrong = (value: string) => value.length >= 10 && /[A-Za-z]/.test(value) && /\d/.test(value)

function Card({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="flex w-full max-w-[430px] flex-col gap-4 rounded-2xl border border-line bg-white p-6 shadow-card">
      <div className="flex flex-col gap-1">
        <h2 className="text-[18px] font-bold text-ink">{title}</h2>
        <p className="text-[13px] text-muted">{description}</p>
      </div>
      {children}
    </section>
  )
}

/**
 * Setting a password with the one-time code the society office issues, for a new account or a
 * forgotten password. There is no SMS sender yet, so the office hands the code over and this
 * screen also lets someone ask for one.
 */
export function SetPasswordPage() {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const [password, setPassword_] = useState('')
  const [confirm, setConfirm] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<'code' | 'ask' | null>(null)
  const [done, setDone] = useState<'set' | 'asked' | null>(null)

  const ready = code.trim().length > 0 && isStrong(password) && password === confirm

  async function handleSet(event: FormEvent) {
    event.preventDefault()
    if (!ready || pending) return
    setPending('code')
    setError(null)
    try {
      await setPassword(code.trim(), password)
      setDone('set')
      setCode('')
      setPassword_('')
      setConfirm('')
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.fields[0]?.message ?? err.message
          : t('auth.login.errors.network'),
      )
    } finally {
      setPending(null)
    }
  }

  async function handleAsk(event: FormEvent) {
    event.preventDefault()
    if (!isValidPhone(phone) || pending) return
    setPending('ask')
    setError(null)
    try {
      await forgotPassword(phone)
      setDone('asked')
      setPhone('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('auth.login.errors.network'))
    } finally {
      setPending(null)
    }
  }

  return (
    <AuthLayout>
      <div className="flex w-full max-w-[430px] flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-[22px] leading-7 font-bold text-ink">{t('auth.setPassword.title')}</h1>
          <p className="text-[13px] text-muted">{t('auth.setPassword.intro')}</p>
        </header>

        {error && (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] font-semibold text-red-700" role="alert">
            {error}
          </p>
        )}

        {done === 'set' ? (
          <Card title={t('auth.setPassword.done.title')} description={t('auth.setPassword.done.description')}>
            <a
              href="/login"
              className="flex h-11 items-center justify-center rounded-xl bg-brand px-4 text-[14px] font-semibold text-white hover:bg-[#125a52]"
            >
              {t('auth.setPassword.done.signIn')}
            </a>
          </Card>
        ) : (
          <Card title={t('auth.setPassword.have.title')} description={t('auth.setPassword.have.description')}>
            <form className="flex flex-col gap-4" onSubmit={handleSet} noValidate>
              <TextField
                id="setup-code"
                label={t('auth.setPassword.have.codeLabel')}
                placeholder="XXXX-XXXX-XXXX"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                hint={t('auth.setPassword.have.codeHint')}
                autoComplete="one-time-code"
                maxLength={20}
                leading={<img src={keyRoundIcon} alt="" width={17} height={17} />}
              />
              <TextField
                id="new-password"
                type="password"
                label={t('auth.setPassword.have.passwordLabel')}
                value={password}
                onChange={(event) => setPassword_(event.target.value)}
                hint={t('auth.setPassword.have.passwordHint')}
                autoComplete="new-password"
                error={password && !isStrong(password) ? t('auth.setPassword.have.passwordHint') : undefined}
              />
              <TextField
                id="confirm-password"
                type="password"
                label={t('auth.setPassword.have.confirmLabel')}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
                error={confirm && confirm !== password ? t('auth.setPassword.have.mismatch') : undefined}
              />
              <Button type="submit" disabled={!ready || pending === 'code'}>
                {pending === 'code' ? t('shell.saving') : t('auth.setPassword.have.submit')}
              </Button>
            </form>
          </Card>
        )}

        {done === 'asked' ? (
          <Card title={t('auth.setPassword.ask.doneTitle')} description={t('auth.setPassword.ask.doneDescription')}>
            <span />
          </Card>
        ) : (
          <Card title={t('auth.setPassword.ask.title')} description={t('auth.setPassword.ask.description')}>
            <form className="flex flex-col gap-4" onSubmit={handleAsk} noValidate>
              <TextField
                id="reset-phone"
                label={t('auth.login.phoneLabel')}
                placeholder={t('auth.login.phonePlaceholder')}
                inputMode="numeric"
                autoComplete="tel-national"
                value={formatPhone(phone)}
                onChange={(event) => setPhone(normalizePhone(event.target.value))}
                leading={
                  <>
                    <img src={smartphoneIcon} alt="" width={17} height={17} />
                    <span className="text-[15px] font-semibold text-ink-soft">{COUNTRY_CODE}</span>
                  </>
                }
              />
              <Button type="submit" disabled={!isValidPhone(phone) || pending === 'ask'}>
                {pending === 'ask' ? t('shell.saving') : t('auth.setPassword.ask.submit')}
              </Button>
            </form>
          </Card>
        )}

        <a href="/login" className="text-center text-[13px] font-semibold text-brand hover:underline">
          {t('auth.setPassword.backToLogin')}
        </a>
      </div>
    </AuthLayout>
  )
}
