import { Car, HeartHandshake } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import { FormGrid, Panel, RowButton, useAction } from '../society/parts'
import { useResource } from '../society/useResource'
import {
  addVehicle,
  createAccessRequest,
  getAttendance,
  listMyAccessRequests,
  listMyDailyHelp,
  listMyVehicles,
  markLeave,
  removeVehicle,
  type AccessRequestKind,
  type Attendance,
  type VehicleType,
} from './api'

const VEHICLE_TYPES: VehicleType[] = ['CAR', 'BIKE', 'SCOOTER', 'BICYCLE', 'OTHER']
const time = (value: string | null) => (value ? new Date(value).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '—')
const day = (value: string) => new Date(value).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })

/** Staff who work for this flat: where they are today, and the attendance behind it. */
export function DailyHelpPanel({ accessToken }: { accessToken: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<string | null>(null)
  const [history, setHistory] = useState<Attendance | null>(null)
  const action = useAction()

  const help = useResource(() => listMyDailyHelp(accessToken), [accessToken])

  async function showAttendance(staffId: string) {
    if (open === staffId) return setOpen(null)
    setHistory(null)
    const ok = await action.run(async () => setHistory(await getAttendance(accessToken, staffId)))
    if (ok) setOpen(staffId)
  }

  return (
    <Panel title={t('area.resident.dailyHelp.title')} description={t('area.resident.dailyHelp.description')}>
      {help.loading ? (
        <Skeleton rows={2} />
      ) : help.error ? (
        <ErrorState message={help.error} onRetry={help.reload} />
      ) : help.data?.length ? (
        <div className="overflow-hidden rounded-xl border border-line">
          {help.data.map((member) => (
            <div key={member.id} className="flex flex-col gap-2 border-t border-line px-4 py-3 first:border-t-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-semibold text-ink">{member.name}</span>
                <span className="text-[12px] text-muted">
                  {member.workType ?? t(`area.admin.staff.kinds.${member.kind}`)}
                  {member.timeWindow ? ` · ${member.timeWindow}` : ''}
                </span>
                <span className="ml-auto">
                  {member.onLeaveToday ? (
                    <Badge tone="neutral">{t('area.resident.dailyHelp.onLeave')}</Badge>
                  ) : member.inside ? (
                    <Badge tone="positive">{t('area.resident.dailyHelp.inSince', { at: time(member.enteredAt) })}</Badge>
                  ) : (
                    <Badge tone="warning">{t('area.resident.dailyHelp.notInToday')}</Badge>
                  )}
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                <RowButton onClick={() => showAttendance(member.id)}>
                  {open === member.id ? t('area.resident.dailyHelp.hideAttendance') : t('area.resident.dailyHelp.seeAttendance')}
                </RowButton>
                <RowButton
                  disabled={action.pending || member.onLeaveToday}
                  onClick={() => action.run(() => markLeave(accessToken, member.id)).then((ok) => ok && help.reload())}
                >
                  {t('area.resident.dailyHelp.markLeave')}
                </RowButton>
              </div>

              {open === member.id && history && (
                <div className="rounded-lg border border-line bg-canvas p-3">
                  {history.attendance.length === 0 && history.leave.length === 0 ? (
                    <p className="m-0 text-[12px] text-muted">{t('area.resident.dailyHelp.noAttendance')}</p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {history.attendance.map((row) => (
                        <li key={row.id} className="flex justify-between text-[12px] text-ink-soft">
                          <span>{day(row.enteredAt)}</span>
                          <span>
                            {time(row.enteredAt)} – {row.exitedAt ? time(row.exitedAt) : t('area.resident.dailyHelp.stillIn')}
                          </span>
                        </li>
                      ))}
                      {history.leave.map((row) => (
                        <li key={row.onDate} className="flex justify-between text-[12px] text-muted">
                          <span>{day(row.onDate)}</span>
                          <span>{t('area.resident.dailyHelp.onLeave')}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={HeartHandshake} title={t('area.resident.dailyHelp.empty.title')} description={t('area.resident.dailyHelp.empty.description')} />
      )}
      {action.error && <ErrorState message={action.error} />}
    </Panel>
  )
}

/** The vehicles the gate lets through without stopping them. */
export function VehiclesPanel({ accessToken, flatId }: { accessToken: string; flatId?: string }) {
  const { t } = useTranslation()
  const [form, setForm] = useState({ number: '', vehicleType: 'CAR' as VehicleType, makeColour: '' })
  const action = useAction()
  const vehicles = useResource(() => listMyVehicles(accessToken), [accessToken])

  async function handleAdd(event: FormEvent) {
    event.preventDefault()
    if (!flatId || !form.number.trim()) return
    const ok = await action.run(() =>
      addVehicle(accessToken, flatId, {
        number: form.number.trim(),
        vehicleType: form.vehicleType,
        ...(form.makeColour.trim() ? { makeColour: form.makeColour.trim() } : {}),
      }),
    )
    if (ok) {
      setForm({ number: '', vehicleType: 'CAR', makeColour: '' })
      vehicles.reload()
    }
  }

  return (
    <Panel title={t('area.resident.vehicles.title')} description={t('area.resident.vehicles.description')}>
      {vehicles.loading ? (
        <Skeleton rows={1} />
      ) : vehicles.data?.length ? (
        <div className="overflow-hidden rounded-xl border border-line">
          {vehicles.data.map((vehicle) => (
            <div key={vehicle.id} className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5 first:border-t-0">
              <span className="text-[14px] font-semibold text-ink">{vehicle.number}</span>
              <Badge tone="neutral">{t(`area.resident.vehicles.types.${vehicle.vehicleType}`)}</Badge>
              <span className="text-[12px] text-muted">{vehicle.makeColour ?? ''}</span>
              <span className="ml-auto">
                <RowButton
                  tone="danger"
                  disabled={action.pending}
                  onClick={() => action.run(() => removeVehicle(accessToken, vehicle.id)).then((ok) => ok && vehicles.reload())}
                >
                  {t('area.resident.vehicles.remove')}
                </RowButton>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={Car} title={t('area.resident.vehicles.empty.title')} description={t('area.resident.vehicles.empty.description')} />
      )}

      {flatId && (
        <form className="flex flex-col gap-3" onSubmit={handleAdd} noValidate>
          <FormGrid>
            <TextField
              id="vehicle-number"
              label={t('area.resident.vehicles.number')}
              value={form.number}
              onChange={(event) => setForm({ ...form, number: event.target.value.toUpperCase() })}
              error={action.fieldError('number')}
              placeholder="MH 12 AB 3344"
              maxLength={16}
              required
            />
            <Select
              id="vehicle-type"
              label={t('area.resident.vehicles.type')}
              options={VEHICLE_TYPES.map((value) => ({ value, label: t(`area.resident.vehicles.types.${value}`) }))}
              value={form.vehicleType}
              onChange={(event) => setForm({ ...form, vehicleType: event.target.value as VehicleType })}
            />
            <TextField
              id="vehicle-make"
              label={t('area.resident.vehicles.makeColour')}
              value={form.makeColour}
              onChange={(event) => setForm({ ...form, makeColour: event.target.value })}
              maxLength={60}
            />
          </FormGrid>
          {action.error && <ErrorState message={action.error} />}
          <div className="sm:w-[180px]">
            <Button type="submit" disabled={action.pending || !form.number.trim()}>
              {t('area.resident.vehicles.add')}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  )
}

/** The two things a resident asks the office for: a household account, or a new daily help. */
export function RequestsPanel({ accessToken, flatId }: { accessToken: string; flatId?: string }) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<AccessRequestKind>('HOUSEHOLD_MEMBER')
  const [form, setForm] = useState({ name: '', phone: '', relationship: '', accessLevel: 'FULL' as 'FULL' | 'VIEW_ONLY', timings: '' })
  const [sent, setSent] = useState<string | null>(null)
  const action = useAction()
  const requests = useResource(() => listMyAccessRequests(accessToken), [accessToken])

  const household = kind === 'HOUSEHOLD_MEMBER'
  const ready = form.name.trim().length > 1 && /^[6-9]\d{9}$/.test(form.phone.trim())

  async function handleSend(event: FormEvent) {
    event.preventDefault()
    if (!flatId || !ready) return
    const ok = await action.run(() =>
      createAccessRequest(accessToken, {
        flatId,
        kind,
        name: form.name.trim(),
        phone: form.phone.trim(),
        ...(form.relationship.trim() ? { relationship: form.relationship.trim() } : {}),
        ...(household ? { accessLevel: form.accessLevel } : {}),
        ...(!household && form.timings.trim() ? { timings: form.timings.trim() } : {}),
      }),
    )
    if (ok) {
      setSent(form.name.trim())
      setForm({ name: '', phone: '', relationship: '', accessLevel: 'FULL', timings: '' })
      requests.reload()
    }
  }

  return (
    <Panel title={t('area.resident.requests.title')} description={t('area.resident.requests.description')}>
      {sent && <SuccessNote message={t('area.resident.requests.sent', { name: sent })} onDismiss={() => setSent(null)} />}

      <div className="flex flex-wrap gap-2">
        {(['HOUSEHOLD_MEMBER', 'DAILY_HELP'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setKind(value)}
            aria-pressed={kind === value}
            className={`h-10 cursor-pointer rounded-lg px-4 text-[13px] font-semibold ${
              kind === value ? 'bg-brand text-white' : 'border border-line-strong bg-white text-ink-soft'
            }`}
          >
            {t(`area.resident.requests.kinds.${value}`)}
          </button>
        ))}
      </div>

      {flatId ? (
        <form className="flex flex-col gap-3" onSubmit={handleSend} noValidate>
          <FormGrid>
            <TextField
              id="request-name"
              label={t('area.resident.requests.name')}
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              error={action.fieldError('name')}
              maxLength={120}
              required
            />
            <TextField
              id="request-phone"
              label={t('area.resident.requests.mobile')}
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value.replace(/\D/g, '').slice(0, 10) })}
              error={action.fieldError('phone')}
              inputMode="numeric"
              required
            />
            <TextField
              id="request-relationship"
              label={household ? t('area.resident.requests.relationship') : t('area.resident.requests.workType')}
              value={form.relationship}
              onChange={(event) => setForm({ ...form, relationship: event.target.value })}
              maxLength={60}
            />
            {household ? (
              <Select
                id="request-access"
                label={t('area.resident.requests.access')}
                options={(['FULL', 'VIEW_ONLY'] as const).map((value) => ({
                  value,
                  label: t(`area.admin.society.residents.access.${value}`),
                }))}
                value={form.accessLevel}
                onChange={(event) => setForm({ ...form, accessLevel: event.target.value as 'FULL' })}
              />
            ) : (
              <TextField
                id="request-timings"
                label={t('area.resident.requests.timings')}
                value={form.timings}
                onChange={(event) => setForm({ ...form, timings: event.target.value })}
                placeholder="7-9 am"
                maxLength={40}
              />
            )}
          </FormGrid>

          <p className="m-0 text-[12px] text-muted">
            {household ? t('area.resident.requests.householdHint') : t('area.resident.requests.helpHint')}
          </p>
          {action.error && <ErrorState message={action.error} />}

          <div className="sm:w-[180px]">
            <Button type="submit" disabled={action.pending || !ready}>
              {t('area.resident.requests.send')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-[13px] text-muted">{t('area.resident.requests.needFullAccess')}</p>
      )}

      {requests.data && requests.data.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line">
          {requests.data.slice(0, 5).map((request) => (
            <div key={request.id} className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5 first:border-t-0">
              <span className="text-[13px] font-semibold text-ink">{request.name}</span>
              <span className="text-[12px] text-muted">{t(`area.resident.requests.kinds.${request.kind}`)}</span>
              <span className="ml-auto">
                <Badge tone={request.status === 'APPROVED' ? 'positive' : request.status === 'REJECTED' ? 'danger' : 'warning'}>
                  {t(`area.resident.requests.status.${request.status}`)}
                </Badge>
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
