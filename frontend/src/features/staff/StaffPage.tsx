import { today } from '../../lib/day'
import { Contact, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, type Tone } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import type { AuthUser } from '../auth/api'
import { PhotoField } from '../file/PhotoField'
import { getOccupancy, listGates, listSocieties, type Gender, type IdDocumentType } from '../society/api'
import { FormGrid, Panel, RowButton, Tabs, useAction, useDeactivate } from '../society/parts'
import { useResource } from '../society/useResource'
import {
  createStaff,
  listStaff,
  reissuePass,
  updateStaff,
  type PoliceVerification,
  type Staff,
  type StaffBody,
  type StaffKind,
  type StaffShift,
  type WorkingDay,
} from './api'

const KINDS: StaffKind[] = ['GUARD', 'DAILY_HELP', 'VENDOR']
const SHIFTS: StaffShift[] = ['MORNING', 'EVENING', 'NIGHT', 'FULL_DAY']
const VERIFICATIONS: PoliceVerification[] = ['NOT_STARTED', 'SUBMITTED', 'VERIFIED', 'REJECTED']
const DAYS: WorkingDay[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const ID_TYPES: IdDocumentType[] = ['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENCE', 'VOTER_ID']
const GENDERS: Gender[] = ['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY']

const VERIFICATION_TONE: Record<PoliceVerification, Tone> = {
  NOT_STARTED: 'neutral',
  SUBMITTED: 'warning',
  VERIFIED: 'positive',
  REJECTED: 'danger',
}


/** The form's own state; everything is a string until it is sent. */
interface FormState {
  name: string
  phone: string
  workType: string
  agency: string
  gateId: string
  shift: string
  policeVerification: PoliceVerification
  gender: string
  homeAddress: string
  workingDays: WorkingDay[]
  idDocumentType: string
  idDocumentLast4: string
  photoReference: string
  passValidFrom: string
  passValidUntil: string
  flatsServed: { flatId: string; timeWindow: string }[]
  consent: boolean
}

const emptyForm = (): FormState => ({
  name: '',
  phone: '',
  workType: '',
  agency: '',
  gateId: '',
  shift: '',
  policeVerification: 'NOT_STARTED',
  gender: '',
  homeAddress: '',
  workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
  idDocumentType: '',
  idDocumentLast4: '',
  photoReference: '',
  passValidFrom: today(),
  passValidUntil: '',
  flatsServed: [],
  consent: false,
})

const formOf = (member: Staff): FormState => ({
  ...emptyForm(),
  name: member.name,
  phone: member.phone,
  workType: member.workType ?? '',
  agency: member.agency ?? '',
  gateId: member.gateId ?? '',
  shift: member.shift ?? '',
  policeVerification: member.policeVerification,
  gender: member.gender ?? '',
  homeAddress: member.homeAddress ?? '',
  workingDays: (member.workingDays?.split(',') ?? []) as WorkingDay[],
  idDocumentType: member.idDocumentType ?? '',
  idDocumentLast4: member.idDocumentLast4 ?? '',
  photoReference: member.photoReference ?? '',
  passValidFrom: member.passValidFrom,
  passValidUntil: member.passValidUntil ?? '',
  flatsServed: member.flatsServed.map((flat) => ({ flatId: flat.flatId, timeWindow: flat.timeWindow ?? '' })),
  // Consent was given when the record was created; editing does not ask again
  consent: true,
})

function StaffRow({ member, onEdit, onDeactivate, onReissue }: {
  member: Staff
  onEdit: (member: Staff) => void
  onDeactivate: (member: Staff) => void
  onReissue: (member: Staff) => void
}) {
  const { t } = useTranslation()
  const places = member.flatsServed
    .map((flat) => `${flat.blockName}-${flat.number}${flat.timeWindow ? ` · ${flat.timeWindow}` : ''}`)
    .join(', ')

  return (
    <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-semibold text-ink">{member.name}</span>
        <span className="text-[12px] text-muted">{member.phone}</span>
        {member.workType && <Badge tone="neutral">{member.workType}</Badge>}
        {member.agency && <span className="text-[12px] text-ink-soft">{member.agency}</span>}
        {member.gateName && <span className="text-[12px] font-semibold text-ink-soft">{member.gateName}</span>}
        {member.shift && <Badge tone="neutral">{t(`area.admin.staff.shifts.${member.shift}`)}</Badge>}
        <Badge tone={VERIFICATION_TONE[member.policeVerification]}>
          {t(`area.admin.staff.verification.${member.policeVerification}`)}
        </Badge>
        <Badge tone={member.status === 'ACTIVE' ? 'positive' : 'danger'}>{t(`area.admin.society.status.${member.status}`)}</Badge>
      </div>

      <p className="text-[12px] text-muted">
        {t('area.admin.staff.pass', { code: member.passCode, from: member.passValidFrom })}
        {member.passValidUntil ? ` · ${t('area.admin.staff.passUntil', { date: member.passValidUntil })}` : ''}
        {member.workingDays ? ` · ${member.workingDays.split(',').map((day) => t(`area.admin.staff.days.${day}`)).join(' ')}` : ''}
        {member.idDocumentOnFile && member.idDocumentType
          ? ` · ${t('area.admin.staff.idOnFile', { type: t(`area.admin.society.residents.idType.${member.idDocumentType}`), last4: member.idDocumentLast4 ?? '' })}`
          : ''}
      </p>
      {places && <p className="text-[12px] text-ink-soft">{t('area.admin.staff.serves', { flats: places })}</p>}

      <div className="flex flex-wrap gap-2">
        <RowButton onClick={() => onEdit(member)}>{t('shell.edit')}</RowButton>
        {member.status === 'ACTIVE' && (
          <>
            <RowButton onClick={() => onReissue(member)}>{t('area.admin.staff.reissue')}</RowButton>
            <RowButton tone="danger" onClick={() => onDeactivate(member)}>
              {t('shell.deactivate')}
            </RowButton>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Staff management: guards on a gate, daily help working for flats, and vendors. Each tab is a
 * kind, and the form below registers one and issues the pass a guard checks at the gate.
 */
export function StaffPage({ user, accessToken }: { user: AuthUser; accessToken: string }) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<StaffKind>(user.permissions.includes('GUARD_MANAGE') ? 'GUARD' : 'DAILY_HELP')
  const [filters, setFilters] = useState({ search: '', shift: '' })
  const [form, setForm] = useState<FormState>(emptyForm())
  const [editing, setEditing] = useState<Staff | null>(null)
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const action = useAction()
  const formPanel = useRef<HTMLElement>(null)

  // Opening the form puts it below the list, so bring it into view instead of leaving the click silent
  useEffect(() => {
    if (open) formPanel.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [open])

  const societies = useResource(() => listSocieties(accessToken), [accessToken])
  const societyId = societies.data?.[0]?.id
  const gates = useResource(societyId ? () => listGates(accessToken, societyId) : null, [accessToken, societyId])
  const occupancy = useResource(societyId ? () => getOccupancy(accessToken, societyId) : null, [accessToken, societyId])
  const staff = useResource(
    societyId
      ? () =>
          listStaff(accessToken, societyId, {
            kind,
            ...(filters.search ? { search: filters.search } : {}),
            ...(filters.shift ? { shift: filters.shift as StaffShift } : {}),
          })
      : null,
    [accessToken, societyId, kind, filters.search, filters.shift],
  )

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((previous) => ({ ...previous, [key]: value }))

  const flatOptions = (occupancy.data?.blocks ?? []).flatMap((block) =>
    block.floors.flatMap((floor) =>
      floor.flats
        .filter((flat) => flat.status === 'ACTIVE')
        .map((flat) => ({ value: flat.id, label: `${block.name}-${flat.number}` })),
    ),
  )

  const deactivate = useDeactivate<Staff>({
    title: t('area.admin.staff.deactivate.title'),
    description: (member) => t('area.admin.staff.deactivate.description', { name: member.name }),
    confirmLabel: t('shell.deactivate'),
    onConfirm: async (member, reason) => {
      await updateStaff(accessToken, member.id, { status: 'INACTIVE', reason })
      staff.reload()
    },
  })

  function startAdd() {
    setEditing(null)
    setForm(emptyForm())
    setOpen(true)
    action.clear()
  }

  function startEdit(member: Staff) {
    setEditing(member)
    setForm(formOf(member))
    setKind(member.kind)
    setOpen(true)
    action.clear()
  }

  const isGuard = kind === 'GUARD'
  const isHelp = kind === 'DAILY_HELP'
  const ready = Boolean(
    form.name.trim() &&
      /^[6-9]\d{9}$/.test(form.phone.trim()) &&
      form.consent &&
      form.passValidFrom &&
      (!isGuard || (form.gateId && form.shift)) &&
      (!isHelp || form.flatsServed.length > 0),
  )

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!societyId) return
    const body: StaffBody & { kind: StaffKind; name: string; phone: string } = {
      kind,
      name: form.name.trim(),
      phone: form.phone.trim(),
      policeVerification: form.policeVerification,
      passValidFrom: form.passValidFrom,
      passValidUntil: form.passValidUntil || null,
      workingDays: form.workingDays,
      gateId: form.gateId || null,
      shift: (form.shift || null) as StaffShift | null,
      ...(form.workType.trim() ? { workType: form.workType.trim() } : {}),
      ...(form.agency.trim() ? { agency: form.agency.trim() } : {}),
      ...(form.gender ? { gender: form.gender as Gender } : {}),
      ...(form.homeAddress.trim() ? { homeAddress: form.homeAddress.trim() } : {}),
      ...(form.idDocumentType ? { idDocumentType: form.idDocumentType as IdDocumentType } : {}),
      ...(form.idDocumentLast4.trim() ? { idDocumentLast4: form.idDocumentLast4.trim().toUpperCase() } : {}),
      ...(form.photoReference.trim() ? { photoReference: form.photoReference.trim() } : {}),
      ...(isHelp || form.flatsServed.length
        ? { flatsServed: form.flatsServed.map((flat) => ({ flatId: flat.flatId, ...(flat.timeWindow.trim() ? { timeWindow: flat.timeWindow.trim() } : {}) })) }
        : {}),
    }
    const { kind: _kind, ...changes } = body
    const ok = await action.run(() =>
      editing ? updateStaff(accessToken, editing.id, changes) : createStaff(accessToken, societyId, body),
    )
    if (ok) {
      setSaved(form.name.trim())
      setOpen(false)
      setEditing(null)
      setForm(emptyForm())
      staff.reload()
    }
  }

  async function handleReissue(member: Staff) {
    if (await action.run(() => reissuePass(accessToken, member.id))) staff.reload()
  }

  if (societies.loading) return <Skeleton rows={5} />
  if (societies.error) return <ErrorState message={societies.error} onRetry={societies.reload} />

  const permitted = KINDS.filter((value) =>
    value === 'GUARD' ? user.permissions.includes('GUARD_MANAGE') : user.permissions.includes('STAFF_MANAGE'),
  )
  const activeKind = permitted.includes(kind) ? kind : permitted[0]!

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.admin.nav.staff')}</h1>
          <p className="text-[13px] text-muted">{t('area.admin.staff.intro')}</p>
        </div>
        <div className="w-[150px]">
          <Button type="button" onClick={startAdd}>
            <span className="flex items-center justify-center gap-2">
              <Plus size={16} aria-hidden />
              {t('area.admin.staff.add')}
            </span>
          </Button>
        </div>
      </header>

      <Tabs
        tabs={permitted.map((value) => ({ key: value, label: t(`area.admin.staff.kinds.${value}`) }))}
        active={activeKind}
        onSelect={(key) => {
          setKind(key as StaffKind)
          setOpen(false)
        }}
      />

      {saved && <SuccessNote message={t('area.admin.staff.saved', { name: saved })} onDismiss={() => setSaved(null)} />}

      <Panel title={t(`area.admin.staff.kinds.${activeKind}`)} description={t('area.admin.staff.listDescription')}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <TextField
            id="staff-search"
            label={t('area.admin.staff.search')}
            value={filters.search}
            onChange={(event) => setFilters({ ...filters, search: event.target.value })}
            placeholder={t('area.admin.staff.searchPlaceholder')}
            maxLength={60}
          />
          {activeKind === 'GUARD' && (
            <Select
              id="staff-shift"
              label={t('area.admin.staff.shift')}
              options={SHIFTS.map((value) => ({ value, label: t(`area.admin.staff.shifts.${value}`) }))}
              placeholder={t('area.admin.staff.allShifts')}
              value={filters.shift}
              onChange={(event) => setFilters({ ...filters, shift: event.target.value })}
            />
          )}
        </div>

        {staff.loading ? (
          <Skeleton rows={3} />
        ) : staff.error ? (
          <ErrorState message={staff.error} onRetry={staff.reload} />
        ) : staff.data?.length ? (
          <div className="overflow-hidden rounded-xl border border-line [&>*:first-child]:border-t-0">
            {staff.data.map((member) => (
              <StaffRow key={member.id} member={member} onEdit={startEdit} onDeactivate={deactivate.ask} onReissue={handleReissue} />
            ))}
          </div>
        ) : (
          <EmptyState icon={Contact} title={t('area.admin.staff.empty.title')} description={t('area.admin.staff.empty.description')} />
        )}
      </Panel>

      {open && (
        <Panel
          ref={formPanel}
          title={editing ? t('area.admin.staff.editTitle', { name: editing.name }) : t(`area.admin.staff.addTitle.${activeKind}`)}
          description={t(`area.admin.staff.addDescription.${activeKind}`)}
        >
          <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
            <FormGrid>
              <TextField
                id="staff-name"
                label={t('area.admin.staff.name')}
                value={form.name}
                onChange={(event) => set('name', event.target.value)}
                error={action.fieldError('name')}
                maxLength={120}
                required
              />
              <TextField
                id="staff-phone"
                label={t('area.admin.staff.phone')}
                inputMode="numeric"
                value={form.phone}
                onChange={(event) => set('phone', event.target.value)}
                error={action.fieldError('phone')}
                maxLength={10}
                required
              />
              <TextField
                id="staff-work-type"
                label={t('area.admin.staff.workType')}
                value={form.workType}
                onChange={(event) => set('workType', event.target.value)}
                error={action.fieldError('workType')}
                hint={t(`area.admin.staff.workTypeHint.${activeKind}`)}
                maxLength={60}
              />
              {activeKind !== 'DAILY_HELP' && (
                <TextField
                  id="staff-agency"
                  label={t('area.admin.staff.agency')}
                  value={form.agency}
                  onChange={(event) => set('agency', event.target.value)}
                  error={action.fieldError('agency')}
                  maxLength={120}
                />
              )}
              {activeKind === 'GUARD' && (
                <>
                  <Select
                    id="staff-gate"
                    label={t('area.admin.staff.gate')}
                    options={(gates.data ?? [])
                      .filter((gate) => gate.status === 'ACTIVE')
                      .map((gate) => ({ value: gate.id, label: gate.name }))}
                    placeholder={t('area.admin.staff.chooseGate')}
                    value={form.gateId}
                    onChange={(event) => set('gateId', event.target.value)}
                    error={action.fieldError('gateId')}
                    hint={gates.data?.length === 0 ? t('area.admin.staff.noGates') : undefined}
                    required
                  />
                  <Select
                    id="staff-shift-field"
                    label={t('area.admin.staff.shift')}
                    options={SHIFTS.map((value) => ({ value, label: t(`area.admin.staff.shifts.${value}`) }))}
                    placeholder={t('area.admin.staff.chooseShift')}
                    value={form.shift}
                    onChange={(event) => set('shift', event.target.value)}
                    error={action.fieldError('shift')}
                    required
                  />
                </>
              )}
              <Select
                id="staff-gender"
                label={t('area.admin.addUser.personal.gender')}
                options={GENDERS.map((value) => ({ value, label: t(`area.admin.addUser.personal.genders.${value}`) }))}
                placeholder={t('area.admin.addUser.personal.notGiven')}
                value={form.gender}
                onChange={(event) => set('gender', event.target.value)}
                error={action.fieldError('gender')}
              />
              <TextField
                id="staff-address"
                label={t('area.admin.staff.homeAddress')}
                value={form.homeAddress}
                onChange={(event) => set('homeAddress', event.target.value)}
                error={action.fieldError('homeAddress')}
                maxLength={500}
              />
              <PhotoField
                id="staff-photo"
                label={t('area.admin.staff.photo')}
                accessToken={accessToken}
                value={form.photoReference}
                onChange={(reference) => set('photoReference', reference)}
                error={action.fieldError('photoReference')}
                required
              />
            </FormGrid>

            {activeKind !== 'GUARD' && (
              <fieldset className="flex flex-col gap-3 rounded-xl border border-line p-4">
                <legend className="px-1 text-[13px] font-bold text-ink">{t('area.admin.staff.flatsServed')}</legend>
                <p className="text-[12px] text-muted">{t('area.admin.staff.flatsServedHint')}</p>
                {form.flatsServed.map((entry, index) => (
                  <div key={index} className="flex flex-wrap items-end gap-3">
                    <div className="min-w-[180px] flex-1">
                      <Select
                        id={`staff-flat-${index}`}
                        label={t('area.admin.staff.flat')}
                        options={flatOptions}
                        placeholder={t('area.admin.addUser.flat.chooseFlat')}
                        value={entry.flatId}
                        onChange={(event) =>
                          set(
                            'flatsServed',
                            form.flatsServed.map((flat, at) => (at === index ? { ...flat, flatId: event.target.value } : flat)),
                          )
                        }
                        required
                      />
                    </div>
                    <div className="min-w-[160px] flex-1">
                      <TextField
                        id={`staff-window-${index}`}
                        label={t('area.admin.staff.timeWindow')}
                        value={entry.timeWindow}
                        onChange={(event) =>
                          set(
                            'flatsServed',
                            form.flatsServed.map((flat, at) => (at === index ? { ...flat, timeWindow: event.target.value } : flat)),
                          )
                        }
                        placeholder={t('area.admin.staff.timeWindowPlaceholder')}
                        maxLength={40}
                      />
                    </div>
                    <RowButton tone="danger" onClick={() => set('flatsServed', form.flatsServed.filter((_, at) => at !== index))}>
                      <span className="flex items-center gap-1">
                        <Trash2 size={14} aria-hidden />
                        {t('shell.remove')}
                      </span>
                    </RowButton>
                  </div>
                ))}
                {action.fieldError('flatsServed') && (
                  <p className="text-[12px] font-semibold text-red-700" role="alert">
                    {action.fieldError('flatsServed')}
                  </p>
                )}
                <div className="w-[150px]">
                  <RowButton onClick={() => set('flatsServed', [...form.flatsServed, { flatId: '', timeWindow: '' }])}>
                    {t('area.admin.staff.addFlat')}
                  </RowButton>
                </div>
              </fieldset>
            )}

            <fieldset className="flex flex-col gap-2 rounded-xl border border-line p-4">
              <legend className="px-1 text-[13px] font-bold text-ink">{t('area.admin.staff.workingDays')}</legend>
              <div className="flex flex-wrap gap-3">
                {DAYS.map((day) => (
                  <label key={day} className="flex items-center gap-2 text-[13px] text-ink-soft">
                    <input
                      type="checkbox"
                      checked={form.workingDays.includes(day)}
                      onChange={(event) =>
                        set('workingDays', event.target.checked ? [...form.workingDays, day] : form.workingDays.filter((value) => value !== day))
                      }
                      className="size-4 accent-[#176b62]"
                    />
                    {t(`area.admin.staff.days.${day}`)}
                  </label>
                ))}
              </div>
            </fieldset>

            <FormGrid>
              <Select
                id="staff-id-type"
                label={t('area.admin.society.register.idType')}
                options={ID_TYPES.map((type) => ({ value: type, label: t(`area.admin.society.residents.idType.${type}`) }))}
                placeholder={t('area.admin.society.register.noId')}
                value={form.idDocumentType}
                onChange={(event) => set('idDocumentType', event.target.value)}
                error={action.fieldError('idDocumentType')}
              />
              <TextField
                id="staff-id-last4"
                label={t('area.admin.society.register.idLast4')}
                value={form.idDocumentLast4}
                onChange={(event) => set('idDocumentLast4', event.target.value)}
                error={action.fieldError('idDocumentLast4')}
                hint={t('area.admin.society.register.idLast4Hint')}
                maxLength={4}
                disabled={!form.idDocumentType}
              />
              <Select
                id="staff-verification"
                label={t('area.admin.staff.policeVerification')}
                options={VERIFICATIONS.map((value) => ({ value, label: t(`area.admin.staff.verification.${value}`) }))}
                value={form.policeVerification}
                onChange={(event) => set('policeVerification', event.target.value as PoliceVerification)}
              />
              <TextField
                id="staff-valid-from"
                label={t('area.admin.staff.passFrom')}
                type="date"
                value={form.passValidFrom}
                onChange={(event) => set('passValidFrom', event.target.value)}
                error={action.fieldError('passValidFrom')}
                required
              />
              <TextField
                id="staff-valid-until"
                label={t('area.admin.staff.passTo')}
                type="date"
                value={form.passValidUntil}
                onChange={(event) => set('passValidUntil', event.target.value)}
                error={action.fieldError('passValidUntil')}
                hint={t('area.admin.staff.passToHint')}
              />
            </FormGrid>

            <label className="flex items-start gap-2 text-[13px] text-ink-soft">
              <input
                type="checkbox"
                checked={form.consent}
                onChange={(event) => set('consent', event.target.checked)}
                className="mt-0.5 size-4 accent-[#176b62]"
              />
              {t('area.admin.staff.consent')}
            </label>

            {action.error && <ErrorState message={action.error} />}

            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-[46px] cursor-pointer rounded-lg border border-line-strong bg-white px-4 text-[15px] font-semibold text-ink-soft hover:bg-canvas"
              >
                {t('shell.cancel')}
              </button>
              <div className="w-[240px]">
                <Button type="submit" disabled={action.pending || !ready}>
                  {action.pending ? t('shell.saving') : editing ? t('shell.save') : t('area.admin.staff.saveAndIssue')}
                </Button>
              </div>
            </div>
          </form>
        </Panel>
      )}
      {deactivate.dialog}
    </div>
  )
}
