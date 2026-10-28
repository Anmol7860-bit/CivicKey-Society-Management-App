import { today } from '../../lib/day'
import { BellOff, QrCode } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, type Tone } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import { listMyFlats } from '../society/api'
import { FormGrid, Panel, RowButton, useAction } from '../society/parts'
import { PrivateImage } from '../file/PhotoField'
import { useResource } from '../society/useResource'
import {
  cancelPass,
  createPass,
  cancelVisit,
  decideVisit,
  listMyPasses,
  listMyVisits,
  type PassStatus,
  type Visit,
  type VisitorPass,
  type VisitPurpose,
  type VisitStatus,
} from './api'

const PURPOSES: VisitPurpose[] = ['GUEST', 'DELIVERY', 'CAB', 'SERVICE', 'OTHER']
const STATUS_TONE: Record<VisitStatus, Tone> = {
  AWAITING_APPROVAL: 'warning',
  CANCELLED: 'neutral',
  REJECTED_AT_GATE: 'danger',
  AWAITING_MANUAL: 'warning',
  APPROVED: 'positive',
  LEAVE_AT_GATE: 'neutral',
  DENIED: 'danger',
  ENTERED: 'brand',
  CLOSED: 'neutral',
}
const PASS_TONE: Record<PassStatus, Tone> = { ACTIVE: 'positive', USED: 'neutral', CANCELLED: 'danger' }

const ago = (value: string) => {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000)
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`
}

const emptyPass = {
  visitorName: '',
  visitorPhone: '',
  purpose: 'GUEST' as VisitPurpose,
  people: '1',
  validOn: today(),
  validFrom: '18:00',
  validUntil: '21:00',
  vehicleNumber: '',
  passType: 'ONE_ENTRY' as const,
  note: '',
}

/** Someone is at the gate for this flat, with the three answers the PDF gives the resident. */
function WaitingCard({ visit, onDecided, token }: { visit: Visit; onDecided: () => void; token: string }) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')
  const action = useAction()

  const decide = async (decision: 'APPROVED' | 'LEAVE_AT_GATE' | 'DENIED') => {
    const ok = await action.run(() =>
      decideVisit(token, visit.id, { decision, ...(decision === 'DENIED' && reason.trim() ? { reason: reason.trim() } : {}) }),
    )
    if (ok) onDecided()
  }

  /** Calling the visit off is not a denial: it ends the visit, and the reason is theirs to give. */
  const cancel = async () => {
    if (await action.run(() => cancelVisit(token, visit.id, reason.trim() ? { reason: reason.trim() } : {}))) onDecided()
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border-2 border-brand bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-bold text-ink">{t('area.resident.visitors.waitingTitle')}</h3>
        <Badge tone="warning">{ago(visit.createdAt)}</Badge>
      </div>

      <div className="flex flex-wrap gap-4">
        <span className="flex size-[84px] shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-canvas p-2 text-center text-[11px] leading-[15px] text-muted">
          {visit.photoReference ? (
            <PrivateImage
              accessToken={token}
              reference={visit.photoReference}
              alt={visit.visitorName}
              className="size-full rounded-lg object-cover"
            />
          ) : (
            t('area.resident.visitors.photoHint')
          )}
        </span>
        <dl className="grid min-w-[200px] flex-1 grid-cols-[84px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-muted">{t('area.resident.visitors.name')}</dt>
        <dd className="m-0 font-semibold text-ink">{visit.visitorName}</dd>
        <dt className="text-muted">{t('area.resident.visitors.purpose')}</dt>
        <dd className="m-0 text-ink-soft">
          {t(`area.guard.purposes.${visit.purpose}`)}
          {visit.company ? ` · ${visit.company}` : ''}
        </dd>
        <dt className="text-muted">{t('area.resident.visitors.people')}</dt>
        <dd className="m-0 text-ink-soft">{visit.people}</dd>
        {visit.vehicleNumber && (
          <>
            <dt className="text-muted">{t('area.resident.visitors.vehicle')}</dt>
            <dd className="m-0 text-ink-soft">{visit.vehicleNumber}</dd>
          </>
        )}
        <dt className="text-muted">{t('area.resident.visitors.gate')}</dt>
        <dd className="m-0 text-ink-soft">
          {visit.gateName ?? '—'}
          {visit.registeredByName ? ` · ${visit.registeredByName}` : ''}
        </dd>
        </dl>
      </div>

      <TextField
        id={`deny-reason-${visit.id}`}
        label={t('area.resident.visitors.reasonLabel')}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={t('area.resident.visitors.reasonPlaceholder')}
        maxLength={200}
      />

      {action.error && <ErrorState message={action.error} />}

      <div className="flex flex-wrap gap-2">
        <div className="w-[160px]">
          <Button type="button" disabled={action.pending} onClick={() => decide('APPROVED')}>
            {t('area.resident.visitors.approve')}
          </Button>
        </div>
        <RowButton disabled={action.pending} onClick={() => decide('LEAVE_AT_GATE')}>
          {t('area.resident.visitors.leaveAtGate')}
        </RowButton>
        <RowButton tone="danger" disabled={action.pending} onClick={() => decide('DENIED')}>
          {t('area.resident.visitors.deny')}
        </RowButton>
        <RowButton disabled={action.pending} onClick={cancel}>
          {t('area.resident.visitors.cancel')}
        </RowButton>
      </div>
      <p className="text-[12px] text-muted">{t('area.resident.visitors.leaveAtGateHint')}</p>
    </div>
  )
}

/** The pass as the visitor sees it: the entry code, large, with what it is good for. */
function PassCard({ pass, onCancelled, token }: { pass: VisitorPass; onCancelled: () => void; token: string }) {
  const { t } = useTranslation()
  const action = useAction()

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-white p-4">
      <span className="flex size-[92px] shrink-0 items-center justify-center rounded-xl border border-line text-muted">
        <QrCode size={44} aria-hidden />
      </span>
      <div className="flex min-w-[200px] flex-1 flex-col gap-1">
        <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t('area.resident.visitors.entryCode')}</span>
        <span className="text-[30px] leading-9 font-bold tracking-[0.18em] text-ink">{pass.entryCode}</span>
        <span className="text-[12px] text-muted">
          {pass.visitorName} · {pass.validOn} · {pass.validFrom.slice(0, 5)}–{pass.validUntil.slice(0, 5)} ·{' '}
          {t(`area.guard.passTypes.${pass.passType}`)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={PASS_TONE[pass.status]}>{t(`area.resident.visitors.passStatus.${pass.status}`)}</Badge>
        {pass.status === 'ACTIVE' && (
          <>
            <RowButton
              onClick={() => {
                const text = t('area.resident.visitors.shareText', {
                  code: pass.entryCode,
                  date: pass.validOn,
                  from: pass.validFrom.slice(0, 5),
                  to: pass.validUntil.slice(0, 5),
                })
                window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener')
              }}
            >
              {t('area.resident.visitors.share')}
            </RowButton>
            <RowButton
              tone="danger"
              disabled={action.pending}
              onClick={() => action.run(() => cancelPass(token, pass.id)).then((ok) => ok && onCancelled())}
            >
              {t('area.resident.visitors.cancel')}
            </RowButton>
          </>
        )}
      </div>
      {action.error && <ErrorState message={action.error} />}
    </div>
  )
}

/** Visitors and passes: answer the gate, and pre-approve the people you are expecting. */
export function VisitorsPage({ accessToken }: { accessToken: string }) {
  const { t } = useTranslation()
  const [form, setForm] = useState(emptyPass)
  const [created, setCreated] = useState<string | null>(null)
  const action = useAction()

  const assignments = useResource(() => listMyFlats(accessToken), [accessToken])
  const visits = useResource(() => listMyVisits(accessToken), [accessToken])
  const passes = useResource(() => listMyPasses(accessToken), [accessToken])

  const flat = assignments.data?.find((assignment) => assignment.active && assignment.accessLevel === 'FULL')
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((previous) => ({ ...previous, [key]: value }))

  if (assignments.loading) return <Skeleton rows={4} />
  if (assignments.error) return <ErrorState message={assignments.error} onRetry={assignments.reload} />

  const waiting = visits.data?.filter((visit) => visit.status === 'AWAITING_APPROVAL') ?? []
  const recent = visits.data?.filter((visit) => visit.status !== 'AWAITING_APPROVAL').slice(0, 8) ?? []

  const ready = Boolean(flat && form.visitorName.trim() && /^[6-9]\d{9}$/.test(form.visitorPhone.trim()) && form.validOn && form.validFrom < form.validUntil)

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (!flat || !ready) return
    const ok = await action.run(async () => {
      const pass = await createPass(accessToken, flat.flatId, {
        visitorName: form.visitorName.trim(),
        visitorPhone: form.visitorPhone.trim(),
        purpose: form.purpose,
        people: Number(form.people) || 1,
        validOn: form.validOn,
        validFrom: form.validFrom,
        validUntil: form.validUntil,
        passType: form.passType,
        ...(form.vehicleNumber.trim() ? { vehicleNumber: form.vehicleNumber.trim() } : {}),
        ...(form.note.trim() ? { note: form.note.trim() } : {}),
      })
      setCreated(pass.entryCode)
    })
    if (ok) {
      setForm(emptyPass)
      passes.reload()
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-[12px] font-semibold text-muted">{t('area.resident.visitors.breadcrumb', { flat: flat?.flat.number ?? '—', block: flat?.block.name ?? '' })}</p>
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.resident.visitors.title')}</h1>
        <p className="text-[13px] text-muted">{t('area.resident.visitors.intro')}</p>
      </header>

      {created && <SuccessNote message={t('area.resident.visitors.created', { code: created })} onDismiss={() => setCreated(null)} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          {visits.loading ? (
            <Skeleton rows={3} />
          ) : visits.error ? (
            <ErrorState message={visits.error} onRetry={visits.reload} />
          ) : waiting.length > 0 ? (
            waiting.map((visit) => <WaitingCard key={visit.id} visit={visit} token={accessToken} onDecided={visits.reload} />)
          ) : (
            <Panel>
              <EmptyState icon={BellOff} title={t('area.resident.visitors.empty.title')} description={t('area.resident.visitors.empty.description')} />
            </Panel>
          )}

          {recent.length > 0 && (
            <Panel title={t('area.resident.visitors.recentTitle')} description={t('area.resident.visitors.recentDescription')}>
              <div className="overflow-hidden rounded-xl border border-line">
                {recent.map((visit) => (
                  <div key={visit.id} className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5 first:border-t-0">
                    <span className="text-[13px] font-semibold text-ink">{visit.visitorName}</span>
                    <span className="text-[12px] text-muted">{t(`area.guard.purposes.${visit.purpose}`)}</span>
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-[12px] text-muted">{ago(visit.createdAt)}</span>
                      <Badge tone={STATUS_TONE[visit.status]}>{t(`area.resident.visitors.status.${visit.status}`)}</Badge>
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>

        <Panel title={t('area.resident.visitors.createTitle')} description={t('area.resident.visitors.createDescription')}>
          {!flat ? (
            <p className="text-[13px] text-muted">{t('area.resident.visitors.needFullAccess')}</p>
          ) : (
            <form className="flex flex-col gap-4" onSubmit={handleCreate} noValidate>
              <FormGrid>
                <TextField
                  id="pass-name"
                  label={t('area.resident.visitors.visitorName')}
                  value={form.visitorName}
                  onChange={(event) => set('visitorName', event.target.value)}
                  error={action.fieldError('visitorName')}
                  maxLength={120}
                  required
                />
                <TextField
                  id="pass-phone"
                  label={t('area.resident.visitors.visitorMobile')}
                  value={form.visitorPhone}
                  onChange={(event) => set('visitorPhone', event.target.value.replace(/\D/g, '').slice(0, 10))}
                  error={action.fieldError('visitorPhone')}
                  hint={t('area.resident.visitors.mobileHint')}
                  inputMode="numeric"
                  required
                />
                <Select
                  id="pass-purpose"
                  label={t('area.resident.visitors.purpose')}
                  options={PURPOSES.map((value) => ({ value, label: t(`area.guard.purposes.${value}`) }))}
                  value={form.purpose}
                  onChange={(event) => set('purpose', event.target.value as VisitPurpose)}
                  required
                />
                <TextField
                  id="pass-people"
                  label={t('area.resident.visitors.people')}
                  type="number"
                  min={1}
                  max={50}
                  value={form.people}
                  onChange={(event) => set('people', event.target.value)}
                />
                <TextField
                  id="pass-date"
                  label={t('area.resident.visitors.date')}
                  type="date"
                  value={form.validOn}
                  onChange={(event) => set('validOn', event.target.value)}
                  error={action.fieldError('validOn')}
                  required
                />
                <div className="flex gap-2">
                  <TextField
                    id="pass-from"
                    label={t('area.resident.visitors.from')}
                    type="time"
                    value={form.validFrom}
                    onChange={(event) => set('validFrom', event.target.value)}
                    required
                  />
                  <TextField
                    id="pass-until"
                    label={t('area.resident.visitors.until')}
                    type="time"
                    value={form.validUntil}
                    onChange={(event) => set('validUntil', event.target.value)}
                    error={action.fieldError('validUntil')}
                    required
                  />
                </div>
                <TextField
                  id="pass-vehicle"
                  label={t('area.resident.visitors.vehicle')}
                  value={form.vehicleNumber}
                  onChange={(event) => set('vehicleNumber', event.target.value.toUpperCase())}
                  placeholder="MH 12 AB 3344"
                  maxLength={16}
                />
                <Select
                  id="pass-type"
                  label={t('area.resident.visitors.passType')}
                  options={(['ONE_ENTRY', 'MULTI_ENTRY'] as const).map((value) => ({ value, label: t(`area.guard.passTypes.${value}`) }))}
                  value={form.passType}
                  onChange={(event) => set('passType', event.target.value as 'ONE_ENTRY')}
                />
              </FormGrid>

              <TextField
                id="pass-note"
                label={t('area.resident.visitors.note')}
                value={form.note}
                onChange={(event) => set('note', event.target.value)}
                placeholder={t('area.resident.visitors.notePlaceholder')}
                maxLength={200}
              />

              {action.error && <ErrorState message={action.error} />}

              <div className="sm:w-[180px]">
                <Button type="submit" disabled={action.pending || !ready}>
                  {action.pending ? t('shell.saving') : t('area.resident.visitors.create')}
                </Button>
              </div>
            </form>
          )}
        </Panel>
      </div>

      <Panel title={t('area.resident.visitors.passesTitle')} description={t('area.resident.visitors.passesDescription')}>
        {passes.loading ? (
          <Skeleton rows={2} />
        ) : passes.error ? (
          <ErrorState message={passes.error} onRetry={passes.reload} />
        ) : passes.data?.length ? (
          <div className="flex flex-col gap-3">
            {passes.data.slice(0, 6).map((pass) => (
              <PassCard key={pass.id} pass={pass} token={accessToken} onCancelled={passes.reload} />
            ))}
          </div>
        ) : (
          <EmptyState icon={QrCode} title={t('area.resident.visitors.noPasses.title')} description={t('area.resident.visitors.noPasses.description')} />
        )}
      </Panel>
    </div>
  )
}
