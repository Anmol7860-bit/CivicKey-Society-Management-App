import { Bug, Check, Copy, Mail } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Field, fieldProps } from '../../components/ui/Field'
import { Select } from '../../components/ui/Select'
import type { AuthUser } from '../auth/api'

const KINDS = ['BUG', 'WRONG_DATA', 'ACCESS', 'SUGGESTION', 'QUESTION'] as const
const QUESTIONS = ['password', 'code', 'approval', 'offline', 'bill'] as const

// Where a report is sent. Unset in local development, in which case the page offers Copy alone.
const SUPPORT_EMAIL = (import.meta.env.VITE_SUPPORT_EMAIL as string | undefined) ?? ''

/**
 * Help centre: the common questions, and a form that turns a complaint into a report the office
 * can act on — what went wrong plus the role, time and browser that support always has to ask for.
 *
 * ponytail: the report leaves by email or clipboard, not through an API. Storing tickets needs a
 * table and a triage screen that the solution design does not describe; decide that before adding it.
 */
export function HelpPage({ user }: { user: AuthUser }) {
  const { t, i18n } = useTranslation()
  const [kind, setKind] = useState<string>('BUG')
  const [detail, setDetail] = useState('')
  const [copied, setCopied] = useState(false)

  const report = [
    `${t('help.report.fields.kind')}: ${t(`help.report.kinds.${kind}`)}`,
    `${t('help.report.fields.detail')}: ${detail.trim()}`,
    `${t('help.report.fields.role')}: ${t(`auth.login.roles.${user.role}`)}`,
    `${t('help.report.fields.reportedBy')}: ${user.name}`,
    `${t('help.report.fields.at')}: ${new Date().toLocaleString(i18n.language)}`,
    `${t('help.report.fields.browser')}: ${navigator.userAgent}`,
  ].join('\n')

  const ready = detail.trim().length >= 10

  async function copy() {
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ponytail: no clipboard permission (or an old browser) — the report is on screen to select
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 text-ink">{t('help.title')}</h1>
        <p className="text-[13px] text-muted">{t('help.intro')}</p>
      </header>

      <section className="flex flex-col gap-4 rounded-2xl border border-line bg-white p-5 shadow-card">
        <div className="flex items-center gap-2">
          <Bug size={17} className="text-brand" aria-hidden />
          <h2 className="text-[16px] font-bold text-ink">{t('help.report.title')}</h2>
        </div>
        <p className="text-[13px] text-muted">{t('help.report.description')}</p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            id="help-kind"
            label={t('help.report.kind')}
            options={KINDS.map((code) => ({ value: code, label: t(`help.report.kinds.${code}`) }))}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          />
        </div>

        <Field id="help-detail" label={t('help.report.detail')} hint={t('help.report.detailHint')} required>
          <textarea
            {...fieldProps('help-detail', undefined, t('help.report.detailHint'))}
            value={detail}
            onChange={(event) => setDetail(event.target.value)}
            rows={5}
            maxLength={2000}
            className="w-full rounded-lg border border-line-strong bg-white px-3 py-2 text-[14px] text-ink focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand/30"
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <h3 className="text-[13px] font-semibold text-ink-soft">{t('help.report.preview')}</h3>
          <pre
            aria-label={t('help.report.preview')}
            className="overflow-x-auto rounded-lg border border-line bg-canvas p-3 text-[12px] leading-5 whitespace-pre-wrap text-ink-soft"
          >
            {report}
          </pre>
          <p className="text-[12px] text-muted">{t('help.report.privacy')}</p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!ready}
            className="flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-white px-3 text-[13px] font-semibold text-ink-soft hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-60"
          >
            {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
            {copied ? t('help.report.copied') : t('help.report.copy')}
          </button>
          {SUPPORT_EMAIL && (
            <a
              href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
                t('help.report.subject', { kind: t(`help.report.kinds.${kind}`) }),
              )}&body=${encodeURIComponent(report)}`}
              aria-disabled={!ready}
              onClick={(event) => !ready && event.preventDefault()}
              className={`flex h-10 items-center gap-2 rounded-lg bg-brand px-4 text-[13px] font-semibold text-white hover:bg-[#125a52] ${
                ready ? '' : 'pointer-events-none opacity-60'
              }`}
            >
              <Mail size={15} aria-hidden />
              {t('help.report.email')}
            </a>
          )}
        </div>
        {!ready && <p className="text-right text-[12px] text-muted">{t('help.report.needDetail')}</p>}
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-5 shadow-card">
        <h2 className="text-[16px] font-bold text-ink">{t('help.questions.title')}</h2>
        <div className="flex flex-col divide-y divide-line">
          {QUESTIONS.map((key) => (
            <details key={key} className="group py-2">
              <summary className="cursor-pointer list-none text-[14px] font-semibold text-ink marker:content-none">
                {t(`help.questions.${key}.q`)}
              </summary>
              <p className="pt-1.5 text-[13px] leading-[21px] text-muted">{t(`help.questions.${key}.a`)}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  )
}
