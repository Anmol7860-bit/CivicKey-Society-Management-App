import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import type { AuthUser } from '../auth/api'
import { PhotoField } from '../file/PhotoField'
import { FormGrid, Panel, RowButton, useAction } from '../society/parts'
import { useResource } from '../society/useResource'
import { flatDirectory, lookupVisitor, registerVisit, validatePass, type VisitPurpose } from './api'

const PURPOSES: VisitPurpose[] = ['GUEST', 'DELIVERY', 'CAB', 'SERVICE', 'OTHER']

const empty = {
  visitorPhone: '',
  visitorName: '',
  company: '',
  purpose: 'GUEST' as VisitPurpose,
  flatId: '',
  people: '1',
  vehicleNumber: '',
  note: '',
  photoReference: '',
  entryCode: '',
}

/**
 * The guard's form, in the order the gate works: the mobile first, because a returning visitor
 * fills the rest in by itself, then who they are and which flat they want.
 */
export function VisitorRegistrationPage({ user, accessToken }: { user: AuthUser; accessToken: string }) {
  const { t } = useTranslation()
  const societyId = user.societyId
  const [form, setForm] = useState(empty)
  const [sent, setSent] = useState<{ name: string; approved: boolean } | null>(null)
  const [known, setKnown] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const action = useAction()
  const pass = useAction()

  const flats = useResource(societyId ? () => flatDirectory(accessToken, societyId) : null, [accessToken, societyId])
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((previous) => ({ ...previous, [key]: value }))

  if (!societyId) return <ErrorState message={t('area.guard.noSociety')} />

  /** A returning visitor: the mobile is the key, so the rest of the form fills itself in. */
  async function findVisitor(phone: string) {
    if (!/^[6-9]\d{9}$/.test(phone) || !societyId) return
    const found = await lookupVisitor(accessToken, societyId, phone).catch(() => null)
    if (!found) return setKnown(null)
    setKnown(t('area.guard.register.known', { flat: found.lastVisit.flat }))
    setForm((previous) => ({
      ...previous,
      visitorName: previous.visitorName || found.visitorName,
      company: previous.company || (found.company ?? ''),
      purpose: found.purpose,
      vehicleNumber: previous.vehicleNumber || (found.vehicleNumber ?? ''),
    }))
  }

  /** The "Visitor has a pass? Scan it" path: the code names the flat, so the form follows it. */
  async function checkPass() {
    if (!societyId || !/^\d{6}$/.test(form.entryCode)) return
    setRefused(null)
    await pass.run(async () => {
      const checked = await validatePass(accessToken, societyId, form.entryCode)
      if (!checked.valid || !checked.pass) {
        setRefused(checked.reason ?? t('area.guard.register.passUnknown'))
        return
      }
      setForm((previous) => ({
        ...previous,
        visitorName: checked.pass!.visitorName,
        visitorPhone: checked.pass!.visitorPhone,
        purpose: checked.pass!.purpose,
        people: String(checked.pass!.people),
        vehicleNumber: checked.pass!.vehicleNumber ?? '',
        note: checked.pass!.note ?? '',
        flatId: checked.pass!.flatId,
      }))
    })
  }

  const ready = Boolean(form.visitorName.trim() && /^[6-9]\d{9}$/.test(form.visitorPhone.trim()) && form.flatId)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!societyId || !ready) return
    const ok = await action.run(async () => {
      const visit = await registerVisit(accessToken, societyId, {
        flatId: form.flatId,
        visitorName: form.visitorName.trim(),
        visitorPhone: form.visitorPhone.trim(),
        purpose: form.purpose,
        people: Number(form.people) || 1,
        ...(form.company.trim() ? { company: form.company.trim() } : {}),
        ...(form.vehicleNumber.trim() ? { vehicleNumber: form.vehicleNumber.trim() } : {}),
        ...(form.note.trim() ? { note: form.note.trim() } : {}),
        ...(form.photoReference.trim() ? { photoReference: form.photoReference.trim() } : {}),
        ...(form.entryCode.trim() ? { entryCode: form.entryCode.trim() } : {}),
      })
      setSent({ name: visit.visitorName, approved: visit.status === 'APPROVED' })
    })
    if (ok) {
      setForm(empty)
      setKnown(null)
      setRefused(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.guard.register.title')}</h1>
          <p className="text-[13px] text-muted">{t('area.guard.register.intro')}</p>
        </div>
      </header>

      {sent && (
        <SuccessNote
          message={sent.approved ? t('area.guard.register.letIn', { name: sent.name }) : t('area.guard.register.sent', { name: sent.name })}
          onDismiss={() => setSent(null)}
        />
      )}

      <Panel title={t('area.guard.register.passTitle')} description={t('area.guard.register.passDescription')}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <TextField
              id="entry-code"
              label={t('area.guard.register.entryCode')}
              value={form.entryCode}
              onChange={(event) => set('entryCode', event.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              placeholder="482913"
            />
          </div>
          <div className="w-[140px]">
            <Button type="button" disabled={pass.pending || form.entryCode.length !== 6} onClick={checkPass}>
              {t('area.guard.register.check')}
            </Button>
          </div>
        </div>
        {(pass.error || refused) && <ErrorState message={(pass.error ?? refused)!} />}
      </Panel>

      <Panel title={t('area.guard.register.formTitle')} description={t('area.guard.register.formDescription')}>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          <FormGrid>
            <TextField
              id="visitor-phone"
              label={t('area.guard.register.mobile')}
              value={form.visitorPhone}
              onChange={(event) => set('visitorPhone', event.target.value.replace(/\D/g, '').slice(0, 10))}
              onBlur={(event) => findVisitor(event.target.value)}
              error={action.fieldError('visitorPhone')}
              hint={known ?? t('area.guard.register.mobileHint')}
              inputMode="numeric"
              required
            />
            <TextField
              id="visitor-name"
              label={t('area.guard.register.name')}
              value={form.visitorName}
              onChange={(event) => set('visitorName', event.target.value)}
              error={action.fieldError('visitorName')}
              maxLength={120}
              required
            />
            <TextField
              id="visitor-company"
              label={t('area.guard.register.company')}
              value={form.company}
              onChange={(event) => set('company', event.target.value)}
              maxLength={120}
            />
          </FormGrid>

          <fieldset className="flex flex-col gap-2 border-0 p-0">
            <legend className="text-[11px] font-semibold text-ink-soft">{t('area.guard.register.purpose')}</legend>
            <div className="flex flex-wrap gap-2">
              {PURPOSES.map((purpose) => (
                <button
                  key={purpose}
                  type="button"
                  onClick={() => set('purpose', purpose)}
                  aria-pressed={form.purpose === purpose}
                  className={`h-11 cursor-pointer rounded-lg px-4 text-[13px] font-semibold ${
                    form.purpose === purpose ? 'bg-brand text-white' : 'border border-line-strong bg-white text-ink-soft'
                  }`}
                >
                  {t(`area.guard.purposes.${purpose}`)}
                </button>
              ))}
            </div>
          </fieldset>

          <FormGrid>
            <Select
              id="visit-flat"
              label={t('area.guard.register.flat')}
              options={(flats.data ?? []).map((flat) => ({
                value: flat.id,
                label: flat.residents.length ? `${flat.label} · ${flat.residents.join(', ')}` : flat.label,
              }))}
              placeholder={t('area.guard.register.chooseFlat')}
              value={form.flatId}
              onChange={(event) => set('flatId', event.target.value)}
              hint={t('area.guard.register.flatHint')}
              required
            />
            <TextField
              id="visit-people"
              label={t('area.guard.register.people')}
              type="number"
              min={1}
              max={50}
              value={form.people}
              onChange={(event) => set('people', event.target.value)}
            />
            <TextField
              id="visit-vehicle"
              label={t('area.guard.register.vehicle')}
              value={form.vehicleNumber}
              onChange={(event) => set('vehicleNumber', event.target.value.toUpperCase())}
              placeholder="MH 12 AB 3344"
              maxLength={16}
            />
            <TextField
              id="visit-note"
              label={t('area.guard.register.note')}
              value={form.note}
              onChange={(event) => set('note', event.target.value)}
              maxLength={200}
            />
            <PhotoField
              id="visit-photo"
              label={t('area.guard.register.photo')}
              accessToken={accessToken}
              value={form.photoReference}
              onChange={(reference) => set('photoReference', reference)}
            />
          </FormGrid>

          {flats.loading && <Skeleton rows={1} />}
          {action.error && <ErrorState message={action.error} />}

          <div className="flex flex-wrap items-center gap-3">
            <div className="w-[260px]">
              <Button type="submit" disabled={action.pending || !ready}>
                {action.pending ? t('shell.saving') : t('area.guard.register.send')}
              </Button>
            </div>
            <RowButton onClick={() => { setForm(empty); setKnown(null); action.clear() }}>{t('area.guard.register.clear')}</RowButton>
            <p className="text-[12px] text-muted">{t('area.guard.register.afterSending')}</p>
          </div>
        </form>
      </Panel>
    </div>
  )
}
