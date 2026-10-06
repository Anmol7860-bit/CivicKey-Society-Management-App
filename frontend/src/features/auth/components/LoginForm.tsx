import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import eyeIcon from '../../../assets/icons/eye.svg'
import eyeOffIcon from '../../../assets/icons/eye-off.svg'
import lockKeyholeIcon from '../../../assets/icons/lock-keyhole.svg'
import logInIcon from '../../../assets/icons/log-in.svg'
import smartphoneIcon from '../../../assets/icons/smartphone.svg'
import { Button } from '../../../components/ui/Button'
import { TextField } from '../../../components/ui/TextField'
import { formatPhone, normalizePhone } from '../phone'

export interface LoginFormValues {
  /** 10 digits, no formatting */
  phone: string
  password: string
}

interface LoginFormProps {
  /** Wired to the login API in the API-integration ticket */
  onSubmit?: (values: LoginFormValues) => void
}

export function LoginForm({ onSubmit }: LoginFormProps) {
  const { t } = useTranslation()
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit?.({ phone, password })
  }

  return (
    <section className="flex w-full max-w-[430px] flex-col gap-3.5 rounded-xl border border-line bg-white p-5 shadow-card sm:gap-4 sm:p-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-bold text-ink sm:text-[28px]">{t('auth.login.title')}</h1>
        <p className="text-[13px] leading-[1.45] text-muted">{t('auth.login.subtitle')}</p>
      </div>

      <form className="flex flex-col gap-3" onSubmit={handleSubmit} noValidate>
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
          leading={<img src={smartphoneIcon} alt="" width={17} height={17} />}
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

        <Button type="submit" icon={<img src={logInIcon} alt="" width={17} height={17} />}>
          {t('auth.login.submit')}
        </Button>
      </form>
    </section>
  )
}
