import { UserCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge, type Tone } from '../../components/ui/Badge'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import {
  listFlatResidents,
  listResidents,
  rejectResident,
  updateResident,
  verifyResident,
  type AccessLevel,
  type Flat,
  type Resident,
  type ResidentFilters,
  type ResidentType,
  type VerificationStatus,
} from './api'
import { Panel, RowButton, useAction, useDeactivate } from './parts'
import { useResource } from './useResource'

const STATUS_TONE: Record<VerificationStatus, Tone> = { PENDING: 'warning', VERIFIED: 'positive', REJECTED: 'danger' }

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
  // What the Admin wants to know about the flat itself once they have searched their way to it
  const flatFacts = [
    resident.floor?.floorLabel,
    resident.flat?.flatType ? t(`area.admin.society.flats.types.${resident.flat.flatType}`) : null,
    resident.flat?.carpetAreaSqft ? t('area.admin.society.flats.area', { area: resident.flat.carpetAreaSqft }) : null,
  ].filter(Boolean)

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

      {flatFacts.length > 0 && <p className="text-[12px] text-muted">{flatFacts.join(' · ')}</p>}

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
  const [filters, setFilters] = useState({ search: '', status: initialStatus, residentType: '', active: '' })
  const query: ResidentFilters = {
    ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.status ? { status: filters.status as VerificationStatus } : {}),
    ...(filters.residentType ? { residentType: filters.residentType as ResidentType } : {}),
    ...(filters.active ? { active: filters.active as 'true' | 'false' } : {}),
  }

  const residents = useResource(
    flat ? () => listFlatResidents(token, flat.id) : () => listResidents(token, societyId, query),
    [token, societyId, flat?.id, filters.search, filters.status, filters.residentType, filters.active],
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
      <Panel
        title={flat ? t('area.admin.society.residents.flatTitle', { number: flat.number }) : t('area.admin.society.residents.title')}
        description={flat ? t('area.admin.society.residents.flatDescription') : t('area.admin.society.residents.description')}
        action={
          flat ? (
            <div className="flex gap-2">
              <Link
                to={`/admin/add-user?flat=${flat.id}`}
                className="flex h-9 items-center rounded-lg bg-brand px-3 text-[13px] font-semibold text-white hover:bg-[#125a52]"
              >
                {t('area.admin.society.residents.addToFlat')}
              </Link>
              <RowButton onClick={onClearFlat}>{t('area.admin.society.residents.showAll')}</RowButton>
            </div>
          ) : undefined
        }
      >
        {!flat && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <TextField
              id="filter-search"
              label={t('area.admin.society.residents.search')}
              value={filters.search}
              onChange={(event) => setFilters({ ...filters, search: event.target.value })}
              placeholder={t('area.admin.society.residents.searchPlaceholder')}
              hint={t('area.admin.society.residents.searchHint')}
              maxLength={60}
            />
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
