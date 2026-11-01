import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import eyeIcon from '../../assets/icons/eye.svg'
import eyeOffIcon from '../../assets/icons/eye-off.svg'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import {
  COMMITTEE_PERMISSIONS,
  createAdmin,
  GENERAL_ADMIN_PERMISSIONS,
  listAdmins,
  listResidents,
  removeCommitteePermissions,
  setCommitteePermissions,
  type AdminPermission,
  type CommitteePermission,
  type IdDocumentType,
  type LoginCode,
} from './api'
import { FormGrid, LoginCodeNote, Panel, RowButton, useAction } from './parts'
import { useResource } from './useResource'

const ID_TYPES = ['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENCE', 'VOTER_ID'] as const

/** One permission, with what it allows written out, as a checkbox the Admin ticks. */
function PermissionBox({ code, checked, onChange }: { code: AdminPermission; checked: boolean; onChange: (on: boolean) => void }) {
  const { t } = useTranslation()
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-line p-3 text-[13px] hover:bg-canvas">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 accent-[#176b62]"
      />
      <span className="flex flex-col gap-0.5">
        <span className="font-semibold text-ink">{t(`area.admin.addUser.admin.codes.${code}.label`)}</span>
        <span className="text-muted">{t(`area.admin.addUser.admin.codes.${code}.description`)}</span>
      </span>
    </label>
  )
}

function Boxes({ codes, chosen, onToggle }: { codes: readonly AdminPermission[]; chosen: string[]; onToggle: (code: AdminPermission, on: boolean) => void }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {codes.map((code) => (
        <PermissionBox key={code} code={code} checked={chosen.includes(code)} onChange={(on) => onToggle(code, on)} />
      ))}
    </div>
  )
}

/**
 * Admin accounts: a new office account with the permissions it is given, and committee access for
 * a resident who already lives here. Both are the same ADMIN role; what differs is what was
 * granted, which is what the server reads on every request.
 */
export function AdminAccounts({ accessToken, societyId }: { accessToken: string; societyId: string | undefined }) {
  const { t } = useTranslation()
  const admins = useResource(societyId ? () => listAdmins(accessToken, societyId) : null, [accessToken, societyId])
  const residents = useResource(
    societyId ? () => listResidents(accessToken, societyId, { active: 'true' }) : null,
    [accessToken, societyId],
  )

  const create = useAction()
  const committee = useAction()
  const [created, setCreated] = useState<string | null>(null)
  const [loginCode, setLoginCode] = useState<LoginCode | null>(null)
  const [granted, setGranted] = useState<string | null>(null)
  const [showId, setShowId] = useState(false)
  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    idDocumentType: '',
    idNumber: '',
    consent: false,
    permissions: [] as AdminPermission[],
  })
  const [member, setMember] = useState({ userId: '', permissions: [] as CommitteePermission[] })

  const toggle = (code: AdminPermission, on: boolean) =>
    setForm((previous) => ({
      ...previous,
      permissions: on ? [...previous.permissions, code] : previous.permissions.filter((kept) => kept !== code),
    }))
  const toggleCommittee = (code: AdminPermission, on: boolean) =>
    setMember((previous) => ({
      ...previous,
      permissions: on
        ? [...previous.permissions, code as CommitteePermission]
        : previous.permissions.filter((kept) => kept !== code),
    }))

  // The office records the document it saw for an Admin too; only the committee path skips it,
  // because a committee member's ID is already on file with their flat registration
  const missing = (
    [
      [!form.name.trim(), 'name'],
      [!form.phone.trim(), 'phone'],
      [!form.idDocumentType, 'idType'],
      [!form.idNumber.trim(), 'idNumber'],
      [!form.consent, 'consent'],
      [form.permissions.length === 0, 'permissions'],
    ] as const
  )
    .filter(([absent]) => absent)
    .map(([, key]) => t(`area.admin.addUser.admin.missing.${key}`))
  const ready = missing.length === 0

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!societyId) return
    let code: LoginCode | null = null
    const body = {
      name: form.name.trim(),
      phone: form.phone.trim(),
      ...(form.email.trim() ? { email: form.email.trim() } : {}),
      permissions: form.permissions,
      idDocumentType: form.idDocumentType as IdDocumentType,
      idNumber: form.idNumber.trim().toUpperCase(),
    }
    if (await create.run(async () => { code = (await createAdmin(accessToken, societyId, body)).loginCode })) {
      setCreated(form.name.trim())
      setLoginCode(code)
      setForm({ name: '', phone: '', email: '', idDocumentType: '', idNumber: '', consent: false, permissions: [] })
      admins.reload()
    }
  }

  async function saveCommittee() {
    const name = residents.data?.find((row) => row.userId === member.userId)?.user.name
    if (await committee.run(() => setCommitteePermissions(accessToken, member.userId, member.permissions))) {
      setGranted(name ?? null)
      setMember({ userId: '', permissions: [] })
      admins.reload()
    }
  }

  async function endCommittee(userId: string) {
    if (await committee.run(() => removeCommitteePermissions(accessToken, userId))) admins.reload()
  }

  // A resident already on the committee is offered the change, not a second grant
  const onCommittee = (userId: string) =>
    admins.data?.find((admin) => admin.id === userId)?.permissions.some((code) => (COMMITTEE_PERMISSIONS as readonly string[]).includes(code)) ??
    false

  return (
    <div className="flex flex-col gap-4">
      <Panel title={t('area.admin.addUser.admin.account.title')} description={t('area.admin.addUser.admin.account.description')}>
        {created && <SuccessNote message={t('area.admin.addUser.admin.done', { name: created })} onDismiss={() => setCreated(null)} />}
        {loginCode && <LoginCodeNote loginCode={loginCode} onDismiss={() => setLoginCode(null)} />}
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <FormGrid>
            <TextField
              id="admin-name"
              label={t('area.admin.society.register.name')}
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              error={create.fieldError('name')}
              maxLength={120}
              required
            />
            <TextField
              id="admin-phone"
              label={t('area.admin.society.register.phone')}
              inputMode="numeric"
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
              error={create.fieldError('phone')}
              hint={t('area.admin.addUser.admin.account.phoneHint')}
              maxLength={10}
              required
            />
            <TextField
              id="admin-email"
              label={t('area.admin.society.register.email')}
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              error={create.fieldError('email')}
            />
          </FormGrid>

          <div className="flex flex-col gap-3">
            <h3 className="text-[13px] font-bold text-ink">{t('area.admin.addUser.admin.identity.title')}</h3>
            <FormGrid>
              <Select
                id="admin-id-type"
                label={t('area.admin.society.register.idType')}
                options={ID_TYPES.map((type) => ({ value: type, label: t(`area.admin.society.residents.idType.${type}`) }))}
                placeholder={t('area.admin.society.register.chooseId')}
                value={form.idDocumentType}
                onChange={(event) => setForm({ ...form, idDocumentType: event.target.value })}
                error={create.fieldError('idDocumentType')}
                required
              />
              <TextField
                id="admin-id-number"
                label={t('area.admin.society.register.idNumber')}
                type={showId ? 'text' : 'password'}
                autoComplete="off"
                value={form.idNumber}
                onChange={(event) => setForm({ ...form, idNumber: event.target.value })}
                error={create.fieldError('idNumber')}
                hint={t('area.admin.society.register.idNumberHint')}
                maxLength={20}
                required
                disabled={!form.idDocumentType}
                trailing={
                  <button
                    type="button"
                    className="-m-1 flex cursor-pointer rounded p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                    aria-label={showId ? t('area.admin.society.register.hideId') : t('area.admin.society.register.showId')}
                    aria-pressed={showId}
                    onClick={() => setShowId((visible) => !visible)}
                  >
                    <img src={showId ? eyeOffIcon : eyeIcon} alt="" width={17} height={17} />
                  </button>
                }
              />
            </FormGrid>
            <label className="flex items-start gap-2 text-[13px] text-ink-soft">
              <input
                type="checkbox"
                checked={form.consent}
                onChange={(event) => setForm({ ...form, consent: event.target.checked })}
                className="mt-0.5 size-4 accent-[#176b62]"
              />
              {t('area.admin.addUser.identity.consent')}
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-[13px] font-bold text-ink">{t('area.admin.addUser.admin.permissions.general')}</h3>
            <Boxes codes={GENERAL_ADMIN_PERMISSIONS} chosen={form.permissions} onToggle={toggle} />
            <h3 className="text-[13px] font-bold text-ink">{t('area.admin.addUser.admin.permissions.committee')}</h3>
            <Boxes codes={COMMITTEE_PERMISSIONS} chosen={form.permissions} onToggle={toggle} />
            <p className="text-[12px] text-muted">{t('area.admin.addUser.admin.permissions.hint')}</p>
          </div>

          {create.error && <ErrorState message={create.error} />}
          {create.fieldError('permissions') && <p className="text-[13px] text-red-700">{create.fieldError('permissions')}</p>}

          <div className="flex flex-wrap items-center justify-end gap-3">
            {/* A disabled button that says nothing reads as a broken button */}
            {!ready && (
              <p className="text-[12px] text-muted">
                {t('area.admin.addUser.admin.missing.still', { fields: missing.join(', ') })}
              </p>
            )}
            <div className="w-[240px]">
              <Button type="submit" disabled={create.pending || !ready}>
                {create.pending ? t('shell.saving') : t('area.admin.addUser.admin.create')}
              </Button>
            </div>
          </div>
        </form>
      </Panel>

      <Panel title={t('area.admin.addUser.admin.committee.title')} description={t('area.admin.addUser.admin.committee.description')}>
        {granted && (
          <SuccessNote message={t('area.admin.addUser.admin.committee.done', { name: granted })} onDismiss={() => setGranted(null)} />
        )}
        {residents.error && <ErrorState message={residents.error} onRetry={residents.reload} />}
        <FormGrid>
          <Select
            id="committee-resident"
            label={t('area.admin.addUser.admin.committee.resident')}
            options={(residents.data ?? []).map((row) => ({
              value: row.userId,
              label: `${row.user.name}${row.block && row.flat ? ` · ${row.block.name}-${row.flat.number}` : ''}`,
            }))}
            placeholder={t('area.admin.addUser.admin.committee.chooseResident')}
            value={member.userId}
            onChange={(event) => setMember({ userId: event.target.value, permissions: [] })}
          />
        </FormGrid>
        <Boxes codes={COMMITTEE_PERMISSIONS} chosen={member.permissions} onToggle={toggleCommittee} />
        {committee.error && <ErrorState message={committee.error} />}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {member.userId && onCommittee(member.userId) && (
            <RowButton tone="danger" onClick={() => void endCommittee(member.userId)} disabled={committee.pending}>
              {t('area.admin.addUser.admin.committee.remove')}
            </RowButton>
          )}
          <div className="w-[240px]">
            <Button
              type="button"
              onClick={() => void saveCommittee()}
              disabled={committee.pending || !member.userId || member.permissions.length === 0}
            >
              {committee.pending ? t('shell.saving') : t('area.admin.addUser.admin.committee.save')}
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title={t('area.admin.addUser.admin.existing.title')}>
        {admins.loading && <Skeleton rows={2} />}
        {admins.error && <ErrorState message={admins.error} onRetry={admins.reload} />}
        {admins.data?.length === 0 && <p className="text-[13px] text-muted">{t('area.admin.addUser.admin.existing.empty')}</p>}
        <ul className="flex flex-col gap-2">
          {(admins.data ?? []).map((admin) => (
            <li key={admin.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-3 text-[13px]">
              <span className="font-semibold text-ink">{admin.name}</span>
              <span className="text-muted">{admin.phone}</span>
              <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">
                {t(`area.admin.addUser.admin.existing.${admin.resident ? 'resident' : 'staff'}`)}
              </span>
              <span className="text-muted">
                {admin.idDocumentOnFile && admin.idDocumentType
                  ? t('area.admin.society.residents.idOnFile', {
                      type: t(`area.admin.society.residents.idType.${admin.idDocumentType}`),
                      last4: admin.idDocumentLast4 ?? '',
                    })
                  : t('area.admin.addUser.admin.existing.noId')}
              </span>
              <span className="text-muted">
                {admin.permissions.length === 0
                  ? t('area.admin.addUser.admin.existing.none')
                  : admin.permissions.map((code) => t(`area.admin.addUser.admin.codes.${code}.label`)).join(', ')}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}
