import { UserCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, type Tone } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import {
  listFlatResidents,
  listResidents,
  registerResident,
  rejectResident,
  updateResident,
  verifyResident,
  type AccessLevel,
  type Flat,
  type RegisterResidentBody,
  type Resident,
  type ResidentFilters,
  type ResidentType,
  type VerificationStatus,
} from './api'
import { FormGrid, Panel, RowButton, useAction, useDeactivate } from './parts'
import { useResource } from './useResource'

const STATUS_TONE: Record<VerificationStatus, Tone> = { PENDING: 'warning', VERIFIED: 'positive', REJECTED: 'danger' }
const ID_TYPES = ['AADHAAR', 'PASSPORT', 'DRIVING_LICENCE', 'VOTER_ID'] as const

const today = () => new Date().toISOString().slice(0, 10)

function ResidentRow({ resident, token, onChanged, onReject, onClose }: {
  resident: Resident
  token: string
  onChanged: () => void
  onReject: (resident: Resident) => void
  onClose: (resident: Resident) => void
}) {
  const { t } = useTranslation()
  const [accessLevel, setAccessLevel] = useState<AccessLevel>(resident.accessLevel)
  const [endDate, setEndDate] = useState(resident.endDate ?? '')
  const [extending, setExtending] = useState(false)
  const action = useAction()

  const verify = () => action.run(() => verifyResident(token, resident.id, { accessLevel })).then((ok) => ok && onChanged())

  async function handleExtend(event: FormEvent) {
    event.preventDefault()
    if (await action.run(() => updateResident(token, resident.id, { endDate }))) {
      setExtending(false)
      onChanged()
    }
  }

  const place = resident.block && resident.flat ? `${resident.block.name} · ${resident.flat.number}` : null

  return (
    <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-semibold text-ink">{resident.user.name}</span>
        <span className="text-[12px] text-muted">{resident.user.phone}</span>
        {place && <span className="text-[12px] font-semibold text-ink-soft">{place}</span>}
        <Badge tone={resident.residentType === 'OWNER' ? 'brand' : 'neutral'}>{t(`area.admin.society.residents.type.${resident.residentType}`)}</Badge>
        <Badge tone={STATUS_TONE[resident.verificationStatus]}>{t(`area.admin.society.residents.status.${resident.verificationStatus}`)}</Badge>
        <Badge tone={resident.accessLevel === 'FULL' ? 'brand' : 'neutral'}>{t(`area.admin.society.residents.access.${resident.accessLevel}`)}</Badge>
        {resident.verificationStatus === 'VERIFIED' && !resident.active && <Badge tone="danger">{t('area.admin.society.residents.ended')}</Badge>}
      </div>

      <p className="text-[12px] text-muted">
        {t('area.admin.society.residents.period', { start: resident.startDate, end: resident.endDate ?? t('area.admin.society.residents.noEnd') })}
        {resident.idDocumentOnFile && resident.idDocumentType
          ? ` · ${t('area.admin.society.residents.idOnFile', { type: t(`area.admin.society.residents.idType.${resident.idDocumentType}`), last4: resident.idDocumentLast4 ?? '' })}`
          : ''}
        {resident.rejectedReason ? ` · ${t('area.admin.society.residents.rejectedFor', { reason: resident.rejectedReason })}` : ''}
      </p>

      {action.error && <p className="text-[12px] font-semibold text-red-700" role="alert">{action.error}</p>}

      {extending ? (
        <form onSubmit={handleExtend} className="flex flex-wrap items-end gap-3" noValidate>
          <div className="w-[190px]">
            <TextField
              id={`resident-end-${resident.id}`}
              label={t('area.admin.society.residents.newEndDate')}
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              error={action.fieldError('endDate')}
              autoFocus
            />
          </div>
          <div className="flex gap-2 pb-0.5">
            <RowButton onClick={() => setExtending(false)}>{t('shell.cancel')}</RowButton>
            <button
              type="submit"
              disabled={action.pending || !endDate}
              className="h-9 cursor-pointer rounded-lg bg-brand px-3 text-[13px] font-semibold text-white hover:bg-[#125a52] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {action.pending ? t('shell.saving') : t('shell.save')}
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {resident.verificationStatus === 'PENDING' && (
            <>
              <select
                aria-label={t('area.admin.society.residents.accessLabel')}
                value={accessLevel}
                onChange={(event) => setAccessLevel(event.target.value as AccessLevel)}
                className="h-9 cursor-pointer rounded-lg border border-line-strong bg-white px-2 text-[13px] text-ink-soft"
              >
                <option value="FULL">{t('area.admin.society.residents.access.FULL')}</option>
                <option value="VIEW_ONLY">{t('area.admin.society.residents.access.VIEW_ONLY')}</option>
              </select>
              <button
                type="button"
                onClick={verify}
                disabled={action.pending}
                className="h-9 cursor-pointer rounded-lg bg-brand px-3 text-[13px] font-semibold text-white hover:bg-[#125a52] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('area.admin.society.residents.verify')}
              </button>
              <RowButton tone="danger" onClick={() => onReject(resident)}>
                {t('area.admin.society.residents.reject')}
              </RowButton>
            </>
          )}
          {resident.active && (
            <>
              <RowButton onClick={() => setExtending(true)}>{t('area.admin.society.residents.extend')}</RowButton>
              <RowButton tone="danger" onClick={() => onClose(resident)}>
                {t('area.admin.society.residents.close')}
              </RowButton>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function RegisterForm({ token, flat, onRegistered }: { token: string; flat: Flat; onRegistered: () => void }) {
  const { t } = useTranslation()
  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    residentType: 'OWNER' as RegisterResidentBody['residentType'],
    accessLevel: 'FULL' as AccessLevel,
    startDate: today(),
    endDate: '',
    idDocumentType: '',
    idDocumentLast4: '',
    proofReference: '',
  })
  const [registered, setRegistered] = useState<string | null>(null)
  const action = useAction()
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((previous) => ({ ...previous, [key]: value }))

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const body: RegisterResidentBody = {
      name: form.name.trim(),
      phone: form.phone.trim(),
      residentType: form.residentType,
      accessLevel: form.accessLevel,
      startDate: form.startDate,
      ...(form.email.trim() ? { email: form.email.trim() } : {}),
      ...(form.residentType === 'TENANT' && form.endDate ? { endDate: form.endDate } : {}),
      ...(form.idDocumentType ? { idDocumentType: form.idDocumentType as RegisterResidentBody['idDocumentType'] } : {}),
      ...(form.idDocumentLast4.trim() ? { idDocumentLast4: form.idDocumentLast4.trim().toUpperCase() } : {}),
      ...(form.proofReference.trim() ? { proofReference: form.proofReference.trim() } : {}),
    }
    if (await action.run(() => registerResident(token, flat.id, body))) {
      setRegistered(form.name.trim())
      setForm({ ...form, name: '', phone: '', email: '', idDocumentLast4: '', proofReference: '' })
      onRegistered()
    }
  }

  return (
    <Panel title={t('area.admin.society.register.title', { number: flat.number })} description={t('area.admin.society.register.description')}>
      {registered && <SuccessNote message={t('area.admin.society.register.done', { name: registered })} onDismiss={() => setRegistered(null)} />}
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <FormGrid>
          <TextField
            id="resident-name"
            label={t('area.admin.society.register.name')}
            value={form.name}
            onChange={(event) => set('name', event.target.value)}
            error={action.fieldError('name')}
            maxLength={120}
            required
          />
          <TextField
            id="resident-phone"
            label={t('area.admin.society.register.phone')}
            inputMode="numeric"
            value={form.phone}
            onChange={(event) => set('phone', event.target.value)}
            error={action.fieldError('phone')}
            hint={t('area.admin.society.register.phoneHint')}
            maxLength={10}
            required
          />
          <TextField
            id="resident-email"
            label={t('area.admin.society.register.email')}
            type="email"
            value={form.email}
            onChange={(event) => set('email', event.target.value)}
            error={action.fieldError('email')}
          />
          <Select
            id="resident-type"
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
          <Select
            id="resident-access"
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
            id="resident-start"
            label={t('area.admin.society.register.startDate')}
            type="date"
            value={form.startDate}
            onChange={(event) => set('startDate', event.target.value)}
            error={action.fieldError('startDate')}
            required
          />
          {form.residentType === 'TENANT' && (
            <TextField
              id="resident-end"
              label={t('area.admin.society.register.endDate')}
              type="date"
              value={form.endDate}
              onChange={(event) => set('endDate', event.target.value)}
              error={action.fieldError('endDate')}
              hint={t('area.admin.society.register.endDateHint')}
              required
            />
          )}
          <Select
            id="resident-id-type"
            label={t('area.admin.society.register.idType')}
            options={ID_TYPES.map((type) => ({ value: type, label: t(`area.admin.society.residents.idType.${type}`) }))}
            placeholder={t('area.admin.society.register.noId')}
            value={form.idDocumentType}
            onChange={(event) => set('idDocumentType', event.target.value)}
            error={action.fieldError('idDocumentType')}
          />
          <TextField
            id="resident-id-last4"
            label={t('area.admin.society.register.idLast4')}
            value={form.idDocumentLast4}
            onChange={(event) => set('idDocumentLast4', event.target.value)}
            error={action.fieldError('idDocumentLast4')}
            hint={t('area.admin.society.register.idLast4Hint')}
            maxLength={4}
            disabled={!form.idDocumentType}
          />
          <TextField
            id="resident-proof"
            label={t('area.admin.society.register.proof')}
            value={form.proofReference}
            onChange={(event) => set('proofReference', event.target.value)}
            error={action.fieldError('proofReference')}
            hint={t('area.admin.society.register.proofHint')}
            maxLength={200}
          />
        </FormGrid>
        {action.error && <ErrorState message={action.error} />}
        <div className="sm:w-[220px]">
          <Button type="submit" disabled={action.pending || !form.name.trim() || !form.phone.trim()}>
            {action.pending ? t('shell.saving') : t('area.admin.society.register.action')}
          </Button>
        </div>
      </form>
    </Panel>
  )
}

/**
 * The resident directory: owners and tenants, their verification state and the whole assignment
 * lifecycle. `?status=PENDING` is the registration review queue. With a flat chosen from Flats,
 * it narrows to that flat and offers registration.
 */
export function ResidentsTab({ token, societyId, flat, onClearFlat, initialStatus = '' }: {
  token: string
  societyId: string
  flat: Flat | null
  onClearFlat: () => void
  initialStatus?: VerificationStatus | ''
}) {
  const { t } = useTranslation()
  // Empty string is "any" in the selects; only the set filters reach the query string
  const [filters, setFilters] = useState({ status: initialStatus, residentType: '', active: '' })
  const query: ResidentFilters = {
    ...(filters.status ? { status: filters.status as VerificationStatus } : {}),
    ...(filters.residentType ? { residentType: filters.residentType as ResidentType } : {}),
    ...(filters.active ? { active: filters.active as 'true' | 'false' } : {}),
  }

  const residents = useResource(
    flat ? () => listFlatResidents(token, flat.id) : () => listResidents(token, societyId, query),
    [token, societyId, flat?.id, filters.status, filters.residentType, filters.active],
  )

  const reject = useDeactivate<Resident>({
    title: t('area.admin.society.residents.rejectTitle'),
    description: (resident) => t('area.admin.society.residents.rejectDescription', { name: resident.user.name }),
    confirmLabel: t('area.admin.society.residents.reject'),
    onConfirm: async (resident, reason) => {
      await rejectResident(token, resident.id, { reason })
      residents.reload()
    },
  })

  const close = useDeactivate<Resident>({
    title: t('area.admin.society.residents.closeTitle'),
    description: (resident) => t('area.admin.society.residents.closeDescription', { name: resident.user.name }),
    confirmLabel: t('area.admin.society.residents.close'),
    onConfirm: async (resident, reason) => {
      await updateResident(token, resident.id, { endDate: today(), reason })
      residents.reload()
    },
  })

  return (
    <div className="flex flex-col gap-4">
      {flat && <RegisterForm token={token} flat={flat} onRegistered={residents.reload} />}

      <Panel
        title={flat ? t('area.admin.society.residents.flatTitle', { number: flat.number }) : t('area.admin.society.residents.title')}
        description={flat ? t('area.admin.society.residents.flatDescription') : t('area.admin.society.residents.description')}
        action={flat ? <RowButton onClick={onClearFlat}>{t('area.admin.society.residents.showAll')}</RowButton> : undefined}
      >
        {!flat && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Select
              id="filter-status"
              label={t('area.admin.society.residents.filterStatus')}
              options={(['PENDING', 'VERIFIED', 'REJECTED'] as const).map((status) => ({
                value: status,
                label: t(`area.admin.society.residents.status.${status}`),
              }))}
              placeholder={t('area.admin.society.residents.any')}
              value={filters.status}
              onChange={(event) => setFilters({ ...filters, status: event.target.value as VerificationStatus | '' })}
            />
            <Select
              id="filter-type"
              label={t('area.admin.society.residents.filterType')}
              options={[
                { value: 'OWNER', label: t('area.admin.society.residents.type.OWNER') },
                { value: 'TENANT', label: t('area.admin.society.residents.type.TENANT') },
              ]}
              placeholder={t('area.admin.society.residents.any')}
              value={filters.residentType}
              onChange={(event) => setFilters({ ...filters, residentType: event.target.value })}
            />
            <Select
              id="filter-active"
              label={t('area.admin.society.residents.filterActive')}
              options={[
                { value: 'true', label: t('area.admin.society.residents.activeNow') },
                { value: 'false', label: t('area.admin.society.residents.notActive') },
              ]}
              placeholder={t('area.admin.society.residents.any')}
              value={filters.active}
              onChange={(event) => setFilters({ ...filters, active: event.target.value })}
            />
          </div>
        )}

        {residents.loading ? (
          <Skeleton rows={4} />
        ) : residents.error ? (
          <ErrorState message={residents.error} onRetry={residents.reload} />
        ) : residents.data?.length ? (
          <div className="overflow-hidden rounded-xl border border-line [&>*:first-child]:border-t-0">
            {residents.data.map((resident) => (
              <ResidentRow
                key={resident.id}
                resident={resident}
                token={token}
                onChanged={residents.reload}
                onReject={reject.ask}
                onClose={close.ask}
              />
            ))}
          </div>
        ) : (
          <EmptyState icon={UserCheck} title={t('area.admin.society.residents.empty.title')} description={t('area.admin.society.residents.empty.description')} />
        )}
      </Panel>
      {reject.dialog}
      {close.dialog}
    </div>
  )
}
