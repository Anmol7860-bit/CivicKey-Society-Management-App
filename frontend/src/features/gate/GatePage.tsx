import { DoorOpen } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import type { AuthUser } from '../auth/api'
import { Panel, RowButton, useAction } from '../society/parts'
import { useResource } from '../society/useResource'
import {
  checkStaffPass,
  rejectStaffEntry,
  listInside,
  listVisits,
  recordEntry,
  recordExit,
  recordStaffEntry,
  recordStaffExit,
  registerVisit,
  validatePass,
  type PassCheck,
  type StaffCheck,
  type StaffRejectionReason,
  type Visit,
} from './api'

const time = (value: string | null) =>
  value ? new Date(value).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '—'

/** A checked pass: green when the guard may let them in, red with the reason when not. */
function PassResult({ check, onAllow, pending }: { check: PassCheck; onAllow: () => void; pending: boolean }) {
  const { t } = useTranslation()
  if (!check.pass) return <ErrorState message={check.reason ?? t('area.guard.gate.passUnknown')} />

  const tone = check.valid ? 'border-emerald-300 bg-emerald-50' : 'border-red-300 bg-red-50'
  return (
    <div className={`flex flex-col gap-3 rounded-xl border p-4 ${tone}`}>
      <p className={`text-[14px] font-bold ${check.valid ? 'text-emerald-900' : 'text-red-800'}`}>
        {check.valid ? t('area.guard.gate.validPass') : check.reason}
      </p>
      <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-muted">{t('area.guard.gate.visitor')}</dt>
        <dd className="m-0 font-semibold text-ink">
          {check.pass.visitorName} · {t('area.guard.gate.people', { count: check.pass.people })}
        </dd>
        <dt className="text-muted">{t('area.guard.gate.flat')}</dt>
        <dd className="m-0 font-semibold text-ink">{check.pass.flat?.label ?? '—'}</dd>
        <dt className="text-muted">{t('area.guard.gate.valid')}</dt>
        <dd className="m-0 text-ink-soft">
          {check.pass.validOn} · {check.pass.validFrom.slice(0, 5)}–{check.pass.validUntil.slice(0, 5)} ·{' '}
          {t(`area.guard.passTypes.${check.pass.passType}`)}
        </dd>
        {check.pass.note && (
          <>
            <dt className="text-muted">{t('area.guard.gate.note')}</dt>
            <dd className="m-0 text-ink-soft">{check.pass.note}</dd>
          </>
        )}
      </dl>
      {check.valid && (
        <div className="w-[240px]">
          <Button type="button" disabled={pending} onClick={onAllow}>
            {t('area.guard.gate.allow')}
          </Button>
        </div>
      )}
    </div>
  )
}

const REJECTION_REASONS: StaffRejectionReason[] = [
  'VERIFICATION_FAILED',
  'STAFF_INACTIVE',
  'INVALID_PASS',
  'NOT_REGISTERED',
  'WRONG_SOCIETY',
  'ALREADY_INSIDE',
  'SECURITY_CONCERN',
  'OTHER',
]

/** The staff card: photo on file, what they do, the flats they serve, and the pass's validity. */
function StaffResult({
  check,
  onEntry,
  onExit,
  onReject,
  pending,
}: {
  check: StaffCheck
  onEntry: () => void
  onExit: () => void
  onReject: (reason: StaffRejectionReason, note?: string) => void
  pending: boolean
}) {
  const { t } = useTranslation()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState<StaffRejectionReason>('VERIFICATION_FAILED')
  const [note, setNote] = useState('')
  if (!check.staff) return <ErrorState message={check.reason ?? t('area.guard.gate.staffUnknown')} />
  // The server refuses OTHER without a description, so the button waits for one
  const canReject = reason !== 'OTHER' || note.trim().length > 2

  return (
    <div className={`flex flex-col gap-3 rounded-xl border p-4 ${check.valid ? 'border-line bg-white' : 'border-red-300 bg-red-50'}`}>
      {!check.valid && <p className="text-[14px] font-bold text-red-800">{check.reason}</p>}
      <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-muted">{t('area.guard.gate.name')}</dt>
        <dd className="m-0 font-semibold text-ink">{check.staff.name}</dd>
        <dt className="text-muted">{t('area.guard.gate.work')}</dt>
        <dd className="m-0 text-ink-soft">
          {check.staff.workType ?? t(`area.admin.staff.kinds.${check.staff.kind}`)}
          {check.staff.flatsServed.length > 0 && ` · ${check.staff.flatsServed.map((flat) => flat.label).join(', ')}`}
        </dd>
        <dt className="text-muted">{t('area.guard.gate.pass')}</dt>
        <dd className="m-0">
          <Badge tone={check.valid ? 'positive' : 'danger'}>
            {check.staff.passValidUntil
              ? t('area.guard.gate.validUntil', { date: check.staff.passValidUntil })
              : t('area.guard.gate.noEnd')}
          </Badge>
        </dd>
      </dl>
      {check.valid && (
        <div className="flex flex-wrap gap-2">
          <div className="w-[160px]">
            <Button type="button" disabled={pending || check.staff.inside} onClick={onEntry}>
              {t('area.guard.gate.recordEntry')}
            </Button>
          </div>
          <RowButton disabled={pending || !check.staff.inside} onClick={onExit}>
            {t('area.guard.gate.recordExit')}
          </RowButton>
          {!check.staff.inside && (
            <RowButton tone="danger" disabled={pending} onClick={() => setRejecting(!rejecting)}>
              {t('area.guard.gate.reject')}
            </RowButton>
          )}
        </div>
      )}
      {check.staff.inside && <p className="text-[12px] text-muted">{t('area.guard.gate.insideSince', { at: time(check.staff.enteredAt) })}</p>}

      {rejecting && (
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-canvas p-3">
          <p className="m-0 text-[13px] font-semibold text-ink">{t('area.guard.gate.rejectTitle')}</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[200px] flex-1">
              <Select
                id="staff-reject-reason"
                label={t('area.guard.gate.rejectReason')}
                options={REJECTION_REASONS.map((value) => ({ value, label: t(`area.guard.gate.rejectReasons.${value}`) }))}
                value={reason}
                onChange={(event) => setReason(event.target.value as StaffRejectionReason)}
              />
            </div>
            {reason === 'OTHER' && (
              <div className="min-w-[200px] flex-1">
                <TextField
                  id="staff-reject-note"
                  label={t('area.guard.gate.rejectNote')}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={200}
                  required
                />
              </div>
            )}
            <div className="h-[46px] flex items-center">
              <RowButton
                tone="danger"
                disabled={pending || !canReject}
                onClick={() => {
                  onReject(reason, note.trim() || undefined)
                  setRejecting(false)
                  setNote('')
                }}
              >
                {t('area.guard.gate.rejectConfirm')}
              </RowButton>
            </div>
          </div>
        </div>
      )}
      <p className="text-[12px] text-muted">{t('area.guard.gate.comparePhoto')}</p>
    </div>
  )
}

/** Pass validation, staff verification and who is inside: the three things a gate does all day. */
export function GatePage({ user, accessToken }: { user: AuthUser; accessToken: string }) {
  const { t } = useTranslation()
  const societyId = user.societyId
  const [code, setCode] = useState('')
  const [passCode, setPassCode] = useState('')
  const [checkedPass, setCheckedPass] = useState<PassCheck | null>(null)
  const [checkedStaff, setCheckedStaff] = useState<StaffCheck | null>(null)
  const [done, setDone] = useState<string | null>(null)
  // One request id per tap. A retry after a lost response reuses it, so the server answers with
  // the movement it already recorded instead of adding a second one.
  const [tap, setTap] = useState(() => crypto.randomUUID())
  const passAction = useAction()
  const staffAction = useAction()
  const entryAction = useAction()

  const inside = useResource(societyId ? () => listInside(accessToken, societyId) : null, [accessToken, societyId])
  const waiting = useResource(
    societyId ? () => listVisits(accessToken, societyId, { status: 'APPROVED' }) : null,
    [accessToken, societyId],
  )

  if (!societyId) return <ErrorState message={t('area.guard.noSociety')} />

  const reload = () => {
    inside.reload()
    waiting.reload()
  }

  /** The pass names the flat, so a visit is registered and let in at once. */
  async function allow(check: PassCheck) {
    if (!check.pass || !societyId) return
    const ok = await entryAction.run(async () => {
      const visit = await registerVisit(accessToken, societyId, {
        flatId: check.pass!.flatId,
        visitorName: check.pass!.visitorName,
        visitorPhone: check.pass!.visitorPhone,
        purpose: check.pass!.purpose,
        people: check.pass!.people,
        entryCode: check.pass!.entryCode,
        ...(check.pass!.vehicleNumber ? { vehicleNumber: check.pass!.vehicleNumber } : {}),
        ...(check.pass!.note ? { note: check.pass!.note } : {}),
      })
      await recordEntry(accessToken, visit.id)
      setDone(t('area.guard.gate.letIn', { name: check.pass!.visitorName }))
    })
    if (ok) {
      setCheckedPass(null)
      setCode('')
      reload()
    }
  }

  async function letInWaiting(visit: Visit) {
    if (await entryAction.run(() => recordEntry(accessToken, visit.id))) {
      setDone(t('area.guard.gate.letIn', { name: visit.visitorName }))
      reload()
    }
  }

  async function markExit(row: { id: string; kind: 'VISITOR' | 'STAFF'; name: string }) {
    const ok = await entryAction.run(() =>
      row.kind === 'VISITOR' ? recordExit(accessToken, row.id) : recordStaffExit(accessToken, row.id, { idempotencyKey: tap }),
    )
    if (ok) {
      setDone(t('area.guard.gate.exitRecorded', { name: row.name }))
      setCheckedStaff(null)
      setTap(crypto.randomUUID())
      reload()
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.guard.gate.title')}</h1>
        <p className="text-[13px] text-muted">{t('area.guard.gate.intro')}</p>
      </header>

      {done && <SuccessNote message={done} onDismiss={() => setDone(null)} />}
      {entryAction.error && <ErrorState message={entryAction.error} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={t('area.guard.gate.passTitle')} description={t('area.guard.gate.passDescription')}>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[180px] flex-1">
              <TextField
                id="gate-entry-code"
                label={t('area.guard.gate.entryCode')}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                placeholder="482913"
              />
            </div>
            <div className="w-[120px]">
              <Button
                type="button"
                disabled={passAction.pending || code.length !== 6}
                onClick={() => passAction.run(async () => setCheckedPass(await validatePass(accessToken, societyId, code)))}
              >
                {t('area.guard.gate.check')}
              </Button>
            </div>
          </div>
          {passAction.error && <ErrorState message={passAction.error} />}
          {checkedPass && <PassResult check={checkedPass} pending={entryAction.pending} onAllow={() => allow(checkedPass)} />}
          <p className="text-[12px] text-muted">{t('area.guard.gate.refusedHint')}</p>
        </Panel>

        <Panel title={t('area.guard.gate.staffTitle')} description={t('area.guard.gate.staffDescription')}>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[180px] flex-1">
              <TextField
                id="gate-staff-pass"
                label={t('area.guard.gate.staffPass')}
                value={passCode}
                onChange={(event) => setPassCode(event.target.value.toUpperCase())}
                placeholder="CK-SEEDHELP"
                maxLength={16}
              />
            </div>
            <div className="w-[120px]">
              <Button
                type="button"
                disabled={staffAction.pending || passCode.trim().length < 3}
                onClick={() => staffAction.run(async () => setCheckedStaff(await checkStaffPass(accessToken, societyId, passCode.trim())))}
              >
                {t('area.guard.gate.check')}
              </Button>
            </div>
          </div>
          {staffAction.error && <ErrorState message={staffAction.error} />}
          {checkedStaff && (
            <StaffResult
              check={checkedStaff}
              pending={entryAction.pending}
              onEntry={async () => {
                if (!checkedStaff.staff) return
                const ok = await entryAction.run(() => recordStaffEntry(accessToken, checkedStaff.staff!.id, { idempotencyKey: tap }))
                if (ok) {
                  setDone(t('area.guard.gate.letIn', { name: checkedStaff.staff.name }))
                  setCheckedStaff({ ...checkedStaff, staff: { ...checkedStaff.staff, inside: true, enteredAt: new Date().toISOString() } })
                  setTap(crypto.randomUUID())
                  reload()
                }
              }}
              onExit={() => checkedStaff.staff && markExit({ id: checkedStaff.staff.id, kind: 'STAFF', name: checkedStaff.staff.name })}
              onReject={async (reason, note) => {
                if (!checkedStaff.staff) return
                const ok = await entryAction.run(() =>
                  rejectStaffEntry(accessToken, checkedStaff.staff!.id, { reason, idempotencyKey: tap, ...(note ? { note } : {}) }),
                )
                if (ok) {
                  setDone(t('area.guard.gate.rejected', { name: checkedStaff.staff.name }))
                  setCheckedStaff(null)
                  setPassCode('')
                  setTap(crypto.randomUUID())
                }
              }}
            />
          )}
        </Panel>
      </div>

      {waiting.data && waiting.data.length > 0 && (
        <Panel title={t('area.guard.gate.approvedTitle')} description={t('area.guard.gate.approvedDescription')}>
          <div className="overflow-hidden rounded-xl border border-line">
            {waiting.data.map((visit) => (
              <div key={visit.id} className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2.5 first:border-t-0">
                <span className="text-[14px] font-semibold text-ink">{visit.visitorName}</span>
                <Badge tone="neutral">{t(`area.guard.purposes.${visit.purpose}`)}</Badge>
                <span className="text-[13px] text-ink-soft">{visit.flat.label}</span>
                <span className="ml-auto">
                  <RowButton disabled={entryAction.pending} onClick={() => letInWaiting(visit)}>
                    {t('area.guard.gate.recordEntry')}
                  </RowButton>
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title={t('area.guard.gate.insideTitle')} description={t('area.guard.gate.insideDescription')}>
        {inside.loading ? (
          <Skeleton rows={3} />
        ) : inside.error ? (
          <ErrorState message={inside.error} onRetry={inside.reload} />
        ) : inside.data?.length ? (
          <div className="overflow-auto rounded-xl border border-line">
            <table className="w-full border-collapse">
              <thead className="bg-canvas">
                <tr>
                  {['name', 'type', 'flat', 'entered', 'vehicle', 'action'].map((column) => (
                    <th key={column} className="px-3 py-2 text-left text-[11px] font-bold tracking-wide text-muted uppercase">
                      {column === 'action' ? '' : t(`area.guard.gate.columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inside.data.map((row) => (
                  <tr key={`${row.kind}-${row.id}`} className="border-t border-line">
                    <td className="px-3 py-2 text-[13px] font-semibold text-ink">{row.name}</td>
                    <td className="px-3 py-2">
                      <Badge tone={row.kind === 'STAFF' ? 'brand' : 'neutral'}>
                        {row.kind === 'STAFF' ? t(`area.admin.staff.kinds.${row.type}`) : t(`area.guard.purposes.${row.type}`)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-[13px] text-ink-soft">{row.flat || '—'}</td>
                    <td className="px-3 py-2 text-[13px] text-ink-soft">{time(row.enteredAt)}</td>
                    <td className="px-3 py-2 text-[13px] text-muted">{row.vehicleNumber ?? '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <RowButton disabled={entryAction.pending} onClick={() => markExit(row)}>
                        {t('area.guard.gate.recordExit')}
                      </RowButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={DoorOpen} title={t('area.guard.gate.empty.title')} description={t('area.guard.gate.empty.description')} />
        )}
      </Panel>
    </div>
  )
}
