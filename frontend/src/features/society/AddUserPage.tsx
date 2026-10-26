import { today } from '../../lib/day'
import { BadgeCheck, Building2, ShieldCheck, UserRound } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import {
  getOccupancy,
  listSocieties,
  registerResident,
  type AccessLevel,
  type Gender,
  type PreferredLanguage,
  type LoginCode,
  type RegisterResidentBody,
} from './api'
import { FormGrid, LoginCodeNote, Panel, useAction } from './parts'
import { useResource } from './useResource'

type Role = 'RESIDENT' | 'GUARD' | 'ADMIN'

const ROLES: { key: Role; icon: typeof UserRound }[] = [
  { key: 'RESIDENT', icon: UserRound },
  { key: 'GUARD', icon: ShieldCheck },
  { key: 'ADMIN', icon: BadgeCheck },
]

const ID_TYPES = ['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENCE', 'VOTER_ID'] as const
const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'] as const
const LANGUAGES = ['en', 'hi', 'mr'] as const


/** A numbered section of the form, as the printed Add user sheet lays them out. */
function Step({ number, title, description, children }: { number: number; title: string; description?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-white p-5 shadow-card">
      <div className="flex gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand/10 text-[13px] font-bold text-brand">
          {number}
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-[16px] font-bold text-ink">{title}</h2>
          {description && <p className="text-[13px] text-muted">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

function Aside({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-line bg-white p-4 shadow-card">
      <h3 className="text-[11px] font-bold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </div>
  )
}

const bullets = (items: string[]) => (
  <ul className="flex list-disc flex-col gap-1.5 pl-4 text-[13px] text-ink-soft">
    {items.map((item) => (
      <li key={item}>{item}</li>
    ))}
  </ul>
)

/**
 * Add user: the Admin's single place to create an account. Only the Resident path has an API
 * today, so Guard and Admin say where they will live rather than offering a form that cannot save.
 */
export function AddUserPage({ accessToken }: { accessToken: string }) {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const [role, setRole] = useState<Role>('RESIDENT')
  const [registered, setRegistered] = useState<string | null>(null)
  // Only a brand-new account gets one; an existing account keeps its own password
  const [loginCode, setLoginCode] = useState<LoginCode | null>(null)
  const action = useAction()

  const societies = useResource(() => listSocieties(accessToken), [accessToken])
  const societyId = societies.data?.[0]?.id
  const occupancy = useResource(societyId ? () => getOccupancy(accessToken, societyId) : null, [accessToken, societyId])

  const [form, setForm] = useState({
    name: '',
    dateOfBirth: '',
    gender: '',
    preferredLanguage: '',
    phone: '',
    email: '',
    alternatePhone: '',
    relationship: '',
    emergencyContactName: '',
    emergencyContactRelationship: '',
    emergencyContactPhone: '',
    blockId: '',
    flatId: params.get('flat') ?? '',
    residentType: 'OWNER' as RegisterResidentBody['residentType'],
    accessLevel: 'FULL' as AccessLevel,
    startDate: today(),
    endDate: '',
    idDocumentType: '',
    idDocumentLast4: '',
    proofReference: '',
    consent: false,
  })
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((previous) => ({ ...previous, [key]: value }))

  const blocks = occupancy.data?.blocks ?? []
  // A flat arriving in the URL from the Residents tab names its block itself, so the block select
  // follows the flat until the Admin picks a different one.
  const owningBlock = blocks.find((block) => block.floors.some((floor) => floor.flats.some((flat) => flat.id === form.flatId)))
  const blockId = form.blockId || owningBlock?.id || ''
  // The flat select carries its floor in the label, so the printed two-field shape still works
  // with a hierarchy that puts a floor between the block and the flat.
  const flatsOfBlock =
    blocks
      .find((block) => block.id === blockId)
      ?.floors.flatMap((floor) => floor.flats.map((flat) => ({ ...flat, floorLabel: floor.floorLabel })))
      .filter((flat) => flat.status === 'ACTIVE') ?? []
  const chosenFlat = flatsOfBlock.some((flat) => flat.id === form.flatId) ? form.flatId : ''

  const isTenant = form.residentType === 'TENANT'
  // A tenancy's end date is optional: it is recorded on move-out, not promised on arrival
  const ready = Boolean(form.name.trim() && form.phone.trim() && chosenFlat && form.startDate && form.consent)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const body: RegisterResidentBody = {
      name: form.name.trim(),
      phone: form.phone.trim(),
      residentType: form.residentType,
      accessLevel: form.accessLevel,
      startDate: form.startDate,
      ...(form.email.trim() ? { email: form.email.trim() } : {}),
      ...(form.dateOfBirth ? { dateOfBirth: form.dateOfBirth } : {}),
      ...(form.gender ? { gender: form.gender as Gender } : {}),
      ...(form.preferredLanguage ? { preferredLanguage: form.preferredLanguage as PreferredLanguage } : {}),
      ...(form.alternatePhone.trim() ? { alternatePhone: form.alternatePhone.trim() } : {}),
      ...(form.relationship.trim() ? { relationship: form.relationship.trim() } : {}),
      ...(form.emergencyContactName.trim() ? { emergencyContactName: form.emergencyContactName.trim() } : {}),
      ...(form.emergencyContactRelationship.trim()
        ? { emergencyContactRelationship: form.emergencyContactRelationship.trim() }
        : {}),
      ...(form.emergencyContactPhone.trim() ? { emergencyContactPhone: form.emergencyContactPhone.trim() } : {}),
      ...(isTenant && form.endDate ? { endDate: form.endDate } : {}),
      ...(form.idDocumentType ? { idDocumentType: form.idDocumentType as RegisterResidentBody['idDocumentType'] } : {}),
      ...(form.idDocumentLast4.trim() ? { idDocumentLast4: form.idDocumentLast4.trim().toUpperCase() } : {}),
      ...(form.proofReference.trim() ? { proofReference: form.proofReference.trim() } : {}),
    }
    let code: LoginCode | null = null
    if (await action.run(async () => { code = (await registerResident(accessToken, chosenFlat, body)).loginCode })) {
      setRegistered(form.name.trim())
      setLoginCode(code)
      setForm({ ...form, name: '', phone: '', email: '', idDocumentLast4: '', proofReference: '', consent: false })
    }
  }

  if (societies.loading || occupancy.loading) return <Skeleton rows={6} />
  if (societies.error) return <ErrorState message={societies.error} onRetry={societies.reload} />

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-[12px] font-semibold text-muted">{t('area.admin.addUser.breadcrumb')}</p>
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.admin.nav.addUser')}</h1>
        <p className="text-[13px] text-muted">{t('area.admin.addUser.intro')}</p>
      </header>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          <Step number={1} title={t('area.admin.addUser.role.title')} description={t('area.admin.addUser.role.description')}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" role="radiogroup" aria-label={t('area.admin.addUser.role.title')}>
              {ROLES.map(({ key, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={role === key}
                  onClick={() => setRole(key)}
                  className={`flex cursor-pointer flex-col gap-1 rounded-xl border p-4 text-left transition-colors ${
                    role === key ? 'border-brand bg-brand/5 ring-3 ring-brand/15' : 'border-line hover:bg-canvas'
                  }`}
                >
                  <Icon size={18} className="text-brand" aria-hidden />
                  <span className="text-[14px] font-bold text-ink">{t(`area.admin.addUser.role.${key}.label`)}</span>
                  <span className="text-[12px] text-muted">{t(`area.admin.addUser.role.${key}.description`)}</span>
                </button>
              ))}
            </div>
          </Step>

          {role !== 'RESIDENT' ? (
            <Panel title={t('area.admin.addUser.notYet.title', { role: t(`area.admin.addUser.role.${role}.label`) })}>
              <p className="text-[13px] text-muted">{t(`area.admin.addUser.notYet.${role}`)}</p>
            </Panel>
          ) : (
            <>
              {registered && (
                <SuccessNote message={t('area.admin.society.register.done', { name: registered })} onDismiss={() => setRegistered(null)} />
              )}

              {loginCode && <LoginCodeNote loginCode={loginCode} onDismiss={() => setLoginCode(null)} />}

              <Step number={2} title={t('area.admin.addUser.personal.title')}>
                <FormGrid>
                  <TextField
                    id="add-name"
                    label={t('area.admin.society.register.name')}
                    value={form.name}
                    onChange={(event) => set('name', event.target.value)}
                    error={action.fieldError('name')}
                    maxLength={120}
                    required
                  />
                  <TextField
                    id="add-dob"
                    label={t('area.admin.addUser.personal.dateOfBirth')}
                    type="date"
                    max={today()}
                    value={form.dateOfBirth}
                    onChange={(event) => set('dateOfBirth', event.target.value)}
                    error={action.fieldError('dateOfBirth')}
                  />
                  <Select
                    id="add-gender"
                    label={t('area.admin.addUser.personal.gender')}
                    options={GENDERS.map((value) => ({ value, label: t(`area.admin.addUser.personal.genders.${value}`) }))}
                    placeholder={t('area.admin.addUser.personal.notGiven')}
                    value={form.gender}
                    onChange={(event) => set('gender', event.target.value)}
                    error={action.fieldError('gender')}
                  />
                  <Select
                    id="add-language"
                    label={t('area.admin.addUser.personal.language')}
                    options={LANGUAGES.map((value) => ({ value, label: t(`area.admin.addUser.personal.languages.${value}`) }))}
                    placeholder={t('area.admin.addUser.personal.notGiven')}
                    value={form.preferredLanguage}
                    onChange={(event) => set('preferredLanguage', event.target.value)}
                    error={action.fieldError('preferredLanguage')}
                    hint={t('area.admin.addUser.personal.languageHint')}
                  />
                </FormGrid>
              </Step>

              <Step number={3} title={t('area.admin.addUser.signIn.title')} description={t('area.admin.addUser.signIn.description')}>
                <FormGrid>
                  <TextField
                    id="add-phone"
                    label={t('area.admin.society.register.phone')}
                    inputMode="numeric"
                    value={form.phone}
                    onChange={(event) => set('phone', event.target.value)}
                    error={action.fieldError('phone')}
                    hint={t('area.admin.addUser.signIn.phoneHint')}
                    maxLength={10}
                    required
                  />
                  <TextField
                    id="add-email"
                    label={t('area.admin.society.register.email')}
                    type="email"
                    value={form.email}
                    onChange={(event) => set('email', event.target.value)}
                    error={action.fieldError('email')}
                    hint={t('area.admin.addUser.signIn.emailHint')}
                  />
                  <TextField
                    id="add-alt-phone"
                    label={t('area.admin.addUser.signIn.alternatePhone')}
                    inputMode="numeric"
                    value={form.alternatePhone}
                    onChange={(event) => set('alternatePhone', event.target.value)}
                    error={action.fieldError('alternatePhone')}
                    maxLength={10}
                  />
                </FormGrid>
              </Step>

              <Step number={4} title={t('area.admin.addUser.flat.title')} description={t('area.admin.addUser.flat.description')}>
                <FormGrid>
                  <Select
                    id="add-block"
                    label={t('area.admin.society.blocks.one')}
                    options={blocks.map((block) => ({ value: block.id, label: block.name }))}
                    placeholder={t('area.admin.society.floors.chooseBlock')}
                    value={blockId}
                    onChange={(event) => setForm({ ...form, blockId: event.target.value, flatId: '' })}
                    required
                  />
                  <Select
                    id="add-flat"
                    label={t('area.admin.addUser.flat.flat')}
                    options={flatsOfBlock.map((flat) => ({ value: flat.id, label: `${flat.floorLabel} · ${flat.number}` }))}
                    placeholder={blockId ? t('area.admin.addUser.flat.chooseFlat') : t('area.admin.society.flats.chooseBlockFirst')}
                    value={chosenFlat}
                    onChange={(event) => set('flatId', event.target.value)}
                    disabled={!blockId}
                    required
                  />
                  <Select
                    id="add-type"
                    label={t('area.admin.society.register.type')}
                    options={[
                      { value: 'OWNER', label: t('area.admin.society.residents.type.OWNER') },
                      { value: 'TENANT', label: t('area.admin.society.residents.type.TENANT') },
                    ]}
                    value={form.residentType}
                    onChange={(event) => set('residentType', event.target.value as RegisterResidentBody['residentType'])}
                    error={action.fieldError('residentType')}
                    required
                  />
                  <TextField
                    id="add-relationship"
                    label={t('area.admin.addUser.flat.relationship')}
                    value={form.relationship}
                    onChange={(event) => set('relationship', event.target.value)}
                    error={action.fieldError('relationship')}
                    hint={t('area.admin.addUser.flat.relationshipHint')}
                    maxLength={60}
                  />
                  <Select
                    id="add-access"
                    label={t('area.admin.society.residents.accessLabel')}
                    options={[
                      { value: 'FULL', label: t('area.admin.society.residents.access.FULL') },
                      { value: 'VIEW_ONLY', label: t('area.admin.society.residents.access.VIEW_ONLY') },
                    ]}
                    value={form.accessLevel}
                    onChange={(event) => set('accessLevel', event.target.value as AccessLevel)}
                    hint={t('area.admin.society.register.accessHint')}
                  />
                  <TextField
                    id="add-start"
                    label={t('area.admin.addUser.flat.moveIn')}
                    type="date"
                    value={form.startDate}
                    onChange={(event) => set('startDate', event.target.value)}
                    error={action.fieldError('startDate')}
                    required
                  />
                  {isTenant && (
                    <TextField
                      id="add-end"
                      label={t('area.admin.society.register.endDate')}
                      type="date"
                      value={form.endDate}
                      onChange={(event) => set('endDate', event.target.value)}
                      error={action.fieldError('endDate')}
                      hint={t('area.admin.society.register.endDateHint')}
                    />
                  )}
                </FormGrid>
              </Step>

              <Step number={5} title={t('area.admin.addUser.identity.title')} description={t('area.admin.addUser.identity.description')}>
                <FormGrid>
                  <Select
                    id="add-id-type"
                    label={t('area.admin.society.register.idType')}
                    options={ID_TYPES.map((type) => ({ value: type, label: t(`area.admin.society.residents.idType.${type}`) }))}
                    placeholder={t('area.admin.society.register.noId')}
                    value={form.idDocumentType}
                    onChange={(event) => set('idDocumentType', event.target.value)}
                    error={action.fieldError('idDocumentType')}
                  />
                  <TextField
                    id="add-id-last4"
                    label={t('area.admin.society.register.idLast4')}
                    value={form.idDocumentLast4}
                    onChange={(event) => set('idDocumentLast4', event.target.value)}
                    error={action.fieldError('idDocumentLast4')}
                    hint={t('area.admin.society.register.idLast4Hint')}
                    maxLength={4}
                    disabled={!form.idDocumentType}
                  />
                  <TextField
                    id="add-proof"
                    label={t('area.admin.society.register.proof')}
                    value={form.proofReference}
                    onChange={(event) => set('proofReference', event.target.value)}
                    error={action.fieldError('proofReference')}
                    hint={t('area.admin.society.register.proofHint')}
                    maxLength={200}
                  />
                </FormGrid>
                <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-900">
                  {t('area.admin.addUser.identity.aadhaar')}
                </p>
                <label className="flex items-start gap-2 text-[13px] text-ink-soft">
                  <input
                    type="checkbox"
                    checked={form.consent}
                    onChange={(event) => set('consent', event.target.checked)}
                    className="mt-0.5 size-4 accent-[#176b62]"
                  />
                  {t('area.admin.addUser.identity.consent')}
                </label>
              </Step>

              <Step number={6} title={t('area.admin.addUser.emergency.title')} description={t('area.admin.addUser.emergency.description')}>
                <FormGrid>
                  <TextField
                    id="add-emergency-name"
                    label={t('area.admin.addUser.emergency.name')}
                    value={form.emergencyContactName}
                    onChange={(event) => set('emergencyContactName', event.target.value)}
                    error={action.fieldError('emergencyContactName')}
                    maxLength={120}
                  />
                  <TextField
                    id="add-emergency-relationship"
                    label={t('area.admin.addUser.emergency.relationship')}
                    value={form.emergencyContactRelationship}
                    onChange={(event) => set('emergencyContactRelationship', event.target.value)}
                    error={action.fieldError('emergencyContactRelationship')}
                    maxLength={60}
                  />
                  <TextField
                    id="add-emergency-phone"
                    label={t('area.admin.addUser.emergency.phone')}
                    inputMode="numeric"
                    value={form.emergencyContactPhone}
                    onChange={(event) => set('emergencyContactPhone', event.target.value)}
                    error={action.fieldError('emergencyContactPhone')}
                    maxLength={10}
                  />
                </FormGrid>
              </Step>

              {action.error && <ErrorState message={action.error} />}

              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, name: '', phone: '', email: '', idDocumentLast4: '', proofReference: '', consent: false })}
                  className="h-[46px] cursor-pointer rounded-lg border border-line-strong bg-white px-4 text-[15px] font-semibold text-ink-soft hover:bg-canvas"
                >
                  {t('shell.cancel')}
                </button>
                <div className="w-[220px]">
                  <Button type="submit" disabled={action.pending || !ready}>
                    {action.pending ? t('shell.saving') : t('area.admin.society.register.action')}
                  </Button>
                </div>
              </div>
            </>
          )}
        </form>

        <aside className="flex flex-col gap-4">
          <Aside title={t('area.admin.addUser.required.title')}>
            {bullets([
              t('area.admin.addUser.required.name'),
              t('area.admin.addUser.required.phone'),
              t('area.admin.addUser.required.flat'),
              t('area.admin.addUser.required.type'),
              t('area.admin.addUser.required.moveIn'),
            ])}
          </Aside>
          <Aside title={t('area.admin.addUser.onSave.title')}>
            {bullets([t('area.admin.addUser.onSave.account'), t('area.admin.addUser.onSave.pending'), t('area.admin.addUser.onSave.audit')])}
          </Aside>
          <Aside title={t('area.admin.addUser.notStored.title')}>
            <p className="text-[13px] text-muted">{t('area.admin.addUser.notStored.description')}</p>
            {bullets([
              t('area.admin.addUser.notStored.photo'),
              t('area.admin.addUser.notStored.documents'),
              t('area.admin.addUser.notStored.draft'),
              t('area.admin.addUser.notStored.invite'),
            ])}
          </Aside>
          {occupancy.error && <ErrorState message={occupancy.error} onRetry={occupancy.reload} />}
          {!occupancy.error && blocks.length === 0 && (
            <Aside title={t('area.admin.society.blocks.empty.title')}>
              <p className="flex items-center gap-2 text-[13px] text-muted">
                <Building2 size={15} aria-hidden />
                {t('area.admin.addUser.noFlats')}
              </p>
            </Aside>
          )}
        </aside>
      </div>
    </div>
  )
}
