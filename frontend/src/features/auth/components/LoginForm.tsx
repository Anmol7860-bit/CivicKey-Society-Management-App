import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import eyeIcon from '../../../assets/icons/eye.svg'
import eyeOffIcon from '../../../assets/icons/eye-off.svg'
import lockKeyholeIcon from '../../../assets/icons/lock-keyhole.svg'
import logInIcon from '../../../assets/icons/log-in.svg'
import smartphoneIcon from '../../../assets/icons/smartphone.svg'
import { Button } from '../../../components/ui/Button'
import { TextField } from '../../../components/ui/TextField'
import { COUNTRY_CODE, formatPhone, isValidPhone, normalizePhone } from '../phone'

export interface LoginFormValues {
  /** 10-digit Indian mobile number without +91 */
  phone: string
  password: string
}

interface LoginFormProps {
  /** Called only with a valid Indian mobile number and a non-empty password */
  onSubmit?: (values: LoginFormValues) => void
  pending?: boolean
  /** Message from a failed sign-in attempt */
  error?: string | null
}

export function LoginForm({ onSubmit, pending = false, error = null }: LoginFormProps) {
  const { t } = useTranslation()
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const problem =
      !isValidPhone(phone)
        ? t('auth.login.errors.phoneInvalid')
        : password.length === 0
          ? t('auth.login.errors.passwordRequired')
          : null
    setValidationError(problem)
    // Move focus to the field to fix, so keyboard and screen reader users land on it
    if (problem) (event.currentTarget.elements.namedItem(isValidPhone(phone) ? 'password' : 'phone') as HTMLInputElement).focus()
    else onSubmit?.({ phone, password })
  }

  const message = validationError ?? error

  return (
    <section className="flex w-full max-w-[430px] flex-col gap-3.5 rounded-xl border border-line bg-white p-5 shadow-card sm:gap-4 sm:p-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-bold text-ink sm:text-[28px]">{t('auth.login.title')}</h1>
        <p className="text-[13px] leading-[1.45] text-muted">{t('auth.login.subtitle')}</p>
      </div>

      <form className="flex flex-col gap-3" onSubmit={handleSubmit} noValidate aria-busy={pending}>
        {message && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
            {message}
          </p>
        )}

        <TextField
          id="phone"
          name="phone"
          type="tel"
          inputMode="numeric"
          autoComplete="username"
          label={t('auth.login.phoneLabel')}
          placeholder={t('auth.login.phonePlaceholder')}
          value={formatPhone(phone)}
          onChange={(event) => setPhone(normalizePhone(event.target.value))}
          leading={
            <>
              <img src={smartphoneIcon} alt="" width={17} height={17} />
              <span className="text-[15px] font-semibold text-ink-soft">{COUNTRY_CODE}</span>
            </>
          }
        />

        <TextField
          id="password"
          name="password"
          type={showPassword ? 'text' : 'password'}
          autoComplete="current-password"
          label={t('auth.login.passwordLabel')}
          placeholder={t('auth.login.passwordPlaceholder')}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          leading={<img src={lockKeyholeIcon} alt="" width={17} height={17} />}
          trailing={
            <button
              type="button"
              className="-m-1 flex cursor-pointer rounded p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              aria-label={showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((visible) => !visible)}
            >
              <img src={showPassword ? eyeOffIcon : eyeIcon} alt="" width={17} height={17} />
            </button>
          }
        />

        <div className="flex justify-end">
          <a
            href="/forgot-password"
            className="rounded text-[13px] font-semibold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            {t('auth.login.forgotPassword')}
          </a>
        </div>

        <Button type="submit" disabled={pending} icon={<img src={logInIcon} alt="" width={17} height={17} />}>
          {pending ? t('auth.login.submitting') : t('auth.login.submit')}
        </Button>
      </form>
    </section>
  )
}
