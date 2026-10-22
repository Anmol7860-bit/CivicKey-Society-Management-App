import { Receipt } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, type Tone } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton, SuccessNote } from '../../components/ui/States'
import { TextField } from '../../components/ui/TextField'
import type { AuthUser } from '../auth/api'
import { listSocieties } from '../society/api'
import { FormGrid, Panel, RowButton, useAction, useDeactivate } from '../society/parts'
import { useResource } from '../society/useResource'
import {
  generateInvoices,
  listInvoices,
  listPayments,
  listRates,
  previewInvoices,
  recordPayment,
  reversePayment,
  setRates,
  type ChargeBasis,
  type Invoice,
  type InvoiceStatus,
  type Payment,
  type Preview,
} from './api'

const STATUS_TONE: Record<InvoiceStatus, Tone> = { UNPAID: 'warning', PARTIALLY_PAID: 'warning', PAID: 'positive', CANCELLED: 'neutral' }

const today = () => new Date().toISOString().slice(0, 10)
const thisMonth = () => today().slice(0, 7)
/** Rupees, as the panels print them */
const rupees = (value: number) => `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Maintenance rates: what the society charges, from a date. Old rates stay on bills already made. */
function RatesPanel({ token, societyId }: { token: string; societyId: string }) {
  const { t } = useTranslation()
  const rates = useResource(() => listRates(token, societyId), [token, societyId])
  const [form, setForm] = useState({
    chargeBasis: 'PER_SQFT' as ChargeBasis,
    rate: '',
    sinkingFund: '',
    parkingCharge: '',
    dueDay: '10',
    lateFeePerDay: '',
    effectiveFrom: `${thisMonth()}-01`,
  })
  const [saved, setSaved] = useState(false)
  const action = useAction()
  const set = (key: keyof typeof form, value: string) => setForm((previous) => ({ ...previous, [key]: value }))

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const body = {
      chargeBasis: form.chargeBasis,
      rate: Number(form.rate),
      sinkingFund: form.sinkingFund.trim() ? Number(form.sinkingFund) : 0,
      parkingCharge: form.parkingCharge.trim() ? Number(form.parkingCharge) : 0,
      dueDay: Number(form.dueDay),
      lateFeePerDay: form.lateFeePerDay.trim() ? Number(form.lateFeePerDay) : null,
      effectiveFrom: form.effectiveFrom,
    }
    if (await action.run(() => setRates(token, societyId, body))) {
      setSaved(true)
      rates.reload()
    }
  }

  const current = rates.data?.[0]

  return (
    <Panel title={t('area.admin.billing.rates.title')} description={t('area.admin.billing.rates.permission')}>
      {saved && <SuccessNote message={t('area.admin.billing.rates.saved')} onDismiss={() => setSaved(false)} />}
      {current && (
        <p className="rounded-xl border border-line bg-canvas p-3 text-[13px] text-ink-soft">
          {t('area.admin.billing.rates.current', {
            basis: t(`area.admin.billing.rates.bases.${current.chargeBasis}`),
            rate: rupees(current.rate),
            from: current.effectiveFrom,
          })}
        </p>
      )}
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            id="rate-basis"
            label={t('area.admin.billing.rates.basis')}
            options={(['PER_SQFT', 'PER_FLAT'] as ChargeBasis[]).map((value) => ({
              value,
              label: t(`area.admin.billing.rates.bases.${value}`),
            }))}
            value={form.chargeBasis}
            onChange={(event) => set('chargeBasis', event.target.value)}
            required
          />
          <TextField
            id="rate-amount"
            label={t('area.admin.billing.rates.rate')}
            type="number"
            min={0}
            step="0.01"
            value={form.rate}
            onChange={(event) => set('rate', event.target.value)}
            error={action.fieldError('rate')}
            required
          />
          <TextField
            id="rate-sinking"
            label={t('area.admin.billing.rates.sinkingFund')}
            type="number"
            min={0}
            step="0.01"
            value={form.sinkingFund}
            onChange={(event) => set('sinkingFund', event.target.value)}
            error={action.fieldError('sinkingFund')}
          />
          <TextField
            id="rate-parking"
            label={t('area.admin.billing.rates.parkingCharge')}
            type="number"
            min={0}
            step="0.01"
            value={form.parkingCharge}
            onChange={(event) => set('parkingCharge', event.target.value)}
            error={action.fieldError('parkingCharge')}
          />
          <TextField
            id="rate-due-day"
            label={t('area.admin.billing.rates.dueDay')}
            type="number"
            min={1}
            max={28}
            value={form.dueDay}
            onChange={(event) => set('dueDay', event.target.value)}
            error={action.fieldError('dueDay')}
            hint={t('area.admin.billing.rates.dueDayHint')}
            required
          />
          <TextField
            id="rate-late-fee"
            label={t('area.admin.billing.rates.lateFee')}
            type="number"
            min={0}
            step="0.01"
            value={form.lateFeePerDay}
            onChange={(event) => set('lateFeePerDay', event.target.value)}
            error={action.fieldError('lateFeePerDay')}
          />
          <TextField
            id="rate-effective"
            label={t('area.admin.billing.rates.effectiveFrom')}
            type="date"
            value={form.effectiveFrom}
            onChange={(event) => set('effectiveFrom', event.target.value)}
            error={action.fieldError('effectiveFrom')}
            hint={t('area.admin.billing.rates.effectiveFromHint')}
            required
          />
        </div>
        {action.error && <ErrorState message={action.error} />}
        <div className="flex justify-end">
          <div className="w-[180px]">
            <Button type="submit" disabled={action.pending || !form.rate.trim() || !form.effectiveFrom}>
              {action.pending ? t('shell.saving') : t('area.admin.billing.rates.save')}
            </Button>
          </div>
        </div>
      </form>
    </Panel>
  )
}

/** Generate invoices: preview the arithmetic first, then write one invoice per flat for the month. */
function GeneratePanel({ token, societyId, onGenerated }: { token: string; societyId: string; onGenerated: () => void }) {
  const { t } = useTranslation()
  const [form, setForm] = useState({ period: thisMonth(), flats: 'OCCUPIED', description: '', amount: '' })
  const [preview, setPreview] = useState<Preview | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const action = useAction()
  const set = (key: keyof typeof form, value: string) => setForm((previous) => ({ ...previous, [key]: value }))

  const body = () => ({
    period: form.period,
    flats: form.flats as 'OCCUPIED' | 'ALL',
    ...(form.amount.trim() ? { oneTimeAmount: Number(form.amount), oneTimeDescription: form.description.trim() } : {}),
  })

  async function handlePreview() {
    await action.run(async () => setPreview(await previewInvoices(token, societyId, body())))
  }

  async function handleGenerate() {
    await action.run(async () => {
      const result = await generateInvoices(token, societyId, body())
      setDone(t('area.admin.billing.generate.done', { count: result.generated, period: result.period }))
      setPreview(null)
      onGenerated()
    })
  }

  return (
    <Panel title={t('area.admin.billing.generate.title')} description={t('area.admin.billing.generate.permission')}>
      {done && <SuccessNote message={done} onDismiss={() => setDone(null)} />}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          id="generate-period"
          label={t('area.admin.billing.generate.period')}
          type="month"
          value={form.period}
          onChange={(event) => set('period', event.target.value)}
          error={action.fieldError('period')}
          required
        />
        <Select
          id="generate-flats"
          label={t('area.admin.billing.generate.flats')}
          options={[
            { value: 'OCCUPIED', label: t('area.admin.billing.generate.occupied') },
            { value: 'ALL', label: t('area.admin.billing.generate.all') },
          ]}
          value={form.flats}
          onChange={(event) => set('flats', event.target.value)}
        />
        <TextField
          id="generate-description"
          label={t('area.admin.billing.generate.oneTimeDescription')}
          value={form.description}
          onChange={(event) => set('description', event.target.value)}
          error={action.fieldError('oneTimeDescription')}
          placeholder={t('area.admin.billing.generate.oneTimePlaceholder')}
          maxLength={120}
        />
        <TextField
          id="generate-amount"
          label={t('area.admin.billing.generate.oneTimeAmount')}
          type="number"
          min={0}
          step="0.01"
          value={form.amount}
          onChange={(event) => set('amount', event.target.value)}
          error={action.fieldError('oneTimeAmount')}
        />
      </div>

      {action.error && <ErrorState message={action.error} />}

      {preview && (
        <div className="flex flex-col gap-2 rounded-xl border border-line p-4">
          <p className="text-[13px] font-semibold text-ink">
            {t('area.admin.billing.generate.previewTitle', { count: preview.lines.length, total: rupees(preview.total) })}
          </p>
          <p className="text-[12px] text-muted">{t('area.admin.billing.generate.due', { date: preview.dueDate })}</p>
          <div className="max-h-[220px] overflow-auto">
            {preview.lines.map((line) => (
              <div key={line.flatId} className="flex items-center gap-3 border-t border-line/60 py-1.5 text-[13px] first:border-t-0">
                <span className="w-24 font-semibold text-ink">{line.flat}</span>
                <span className="text-muted">
                  {t('area.admin.billing.generate.breakdown', {
                    maintenance: rupees(line.maintenance),
                    sinking: rupees(line.sinkingFund),
                    parking: rupees(line.parkingCharge),
                  })}
                </span>
                <span className="ml-auto font-semibold text-ink">{rupees(line.total)}</span>
              </div>
            ))}
          </div>
          {preview.skipped.length > 0 && (
            <p className="text-[12px] text-amber-800">
              {t('area.admin.billing.generate.skipped', {
                list: preview.skipped.map((entry) => `${entry.flat} (${entry.reason})`).join(', '),
              })}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <RowButton onClick={handlePreview} disabled={action.pending || !form.period}>
          {t('area.admin.billing.generate.preview')}
        </RowButton>
        <div className="w-[190px]">
          <Button type="button" onClick={handleGenerate} disabled={action.pending || !form.period}>
            {action.pending ? t('shell.saving') : t('area.admin.billing.generate.action')}
          </Button>
        </div>
      </div>
    </Panel>
  )
}

/** Record a cash payment against an invoice and issue its receipt. */
function PaymentPanel({ token, invoices, onPaid }: { token: string; invoices: Invoice[]; onPaid: () => void }) {
  const { t } = useTranslation()
  const [form, setForm] = useState({ flatId: '', invoiceId: '', amount: '', receivedOn: today(), paidBy: '', note: '' })
  const [receipt, setReceipt] = useState<Payment | null>(null)
  const action = useAction()
  const set = (key: keyof typeof form, value: string) => setForm((previous) => ({ ...previous, [key]: value }))

  const flats = [...new Map(invoices.map((invoice) => [invoice.flatId, invoice.flat])).values()]
  const open = invoices.filter((invoice) => invoice.flatId === form.flatId && invoice.outstanding > 0)
  const chosen = open.find((invoice) => invoice.id === form.invoiceId)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const body = {
      amount: Number(form.amount),
      receivedOn: form.receivedOn,
      ...(form.paidBy.trim() ? { paidBy: form.paidBy.trim() } : {}),
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
    }
    await action.run(async () => {
      const payment = await recordPayment(token, form.invoiceId, body)
      setReceipt(payment)
      setForm({ ...form, amount: '', paidBy: '', note: '', invoiceId: '' })
      onPaid()
    })
  }

  return (
    <Panel title={t('area.admin.billing.payment.title')} description={t('area.admin.billing.payment.permission')}>
      {receipt && (
        <SuccessNote
          message={t('area.admin.billing.payment.issued', { receipt: receipt.receiptNumber, amount: rupees(receipt.amount) })}
          onDismiss={() => setReceipt(null)}
        />
      )}
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <FormGrid>
          <Select
            id="payment-flat"
            label={t('area.admin.billing.payment.flat')}
            options={flats.map((flat) => ({ value: flat.id, label: `${flat.blockName}-${flat.number}` }))}
            placeholder={t('area.admin.billing.payment.chooseFlat')}
            value={form.flatId}
            onChange={(event) => setForm({ ...form, flatId: event.target.value, invoiceId: '' })}
            required
          />
          <Select
            id="payment-invoice"
            label={t('area.admin.billing.payment.invoice')}
            options={open.map((invoice) => ({
              value: invoice.id,
              label: t('area.admin.billing.payment.invoiceLabel', { period: invoice.period.slice(0, 7), due: rupees(invoice.outstanding) }),
            }))}
            placeholder={form.flatId ? t('area.admin.billing.payment.chooseInvoice') : t('area.admin.billing.payment.chooseFlatFirst')}
            value={form.invoiceId}
            onChange={(event) => set('invoiceId', event.target.value)}
            disabled={!form.flatId}
            required
          />
          <TextField
            id="payment-amount"
            label={t('area.admin.billing.payment.amount')}
            type="number"
            min={0}
            step="0.01"
            value={form.amount}
            onChange={(event) => set('amount', event.target.value)}
            error={action.fieldError('amount')}
            hint={chosen ? t('area.admin.billing.payment.outstanding', { amount: rupees(chosen.outstanding) }) : undefined}
            required
          />
          <TextField
            id="payment-received"
            label={t('area.admin.billing.payment.receivedOn')}
            type="date"
            value={form.receivedOn}
            onChange={(event) => set('receivedOn', event.target.value)}
            error={action.fieldError('receivedOn')}
            required
          />
          <TextField
            id="payment-paid-by"
            label={t('area.admin.billing.payment.paidBy')}
            value={form.paidBy}
            onChange={(event) => set('paidBy', event.target.value)}
            error={action.fieldError('paidBy')}
            placeholder={t('area.admin.billing.payment.paidByPlaceholder')}
            maxLength={120}
          />
          <TextField
            id="payment-note"
            label={t('area.admin.billing.payment.note')}
            value={form.note}
            onChange={(event) => set('note', event.target.value)}
            error={action.fieldError('note')}
            maxLength={200}
          />
        </FormGrid>
        <p className="text-[12px] text-muted">{t('area.admin.billing.payment.receiptNote')}</p>
        {action.error && <ErrorState message={action.error} />}
        <div className="flex justify-end">
          <div className="w-[280px]">
            <Button type="submit" disabled={action.pending || !form.invoiceId || !form.amount.trim()}>
              {action.pending ? t('shell.saving') : t('area.admin.billing.payment.action')}
            </Button>
          </div>
        </div>
      </form>
    </Panel>
  )
}

/** What has been billed, what is paid, and the receipts behind each invoice. */
function InvoicesPanel({ token, invoices, loading, error, onReload, mayReverse }: {
  token: string
  invoices: Invoice[]
  loading: boolean
  error?: string
  onReload: () => void
  mayReverse: boolean
}) {
  const { t } = useTranslation()
  const [openId, setOpenId] = useState<string | null>(null)

  const reverse = useDeactivate<Payment>({
    title: t('area.admin.billing.invoices.reverseTitle'),
    description: (payment) => t('area.admin.billing.invoices.reverseDescription', { receipt: payment.receiptNumber }),
    confirmLabel: t('area.admin.billing.invoices.reverse'),
    onConfirm: async (payment, reason) => {
      await reversePayment(token, payment.id, { reason })
      onReload()
    },
  })

  if (loading) return <Skeleton rows={4} />
  if (error) return <ErrorState message={error} onRetry={onReload} />

  return (
    <Panel title={t('area.admin.billing.invoices.title')} description={t('area.admin.billing.invoices.description')}>
      {invoices.length === 0 ? (
        <EmptyState icon={Receipt} title={t('area.admin.billing.invoices.empty.title')} description={t('area.admin.billing.invoices.empty.description')} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line [&>*:first-child]:border-t-0">
          {invoices.map((invoice) => (
            <div key={invoice.id} className="flex flex-col gap-2 border-t border-line px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-semibold text-ink">
                  {invoice.flat.blockName}-{invoice.flat.number}
                </span>
                <span className="text-[12px] text-muted">{invoice.period.slice(0, 7)}</span>
                <Badge tone={STATUS_TONE[invoice.status]}>{t(`area.admin.billing.invoices.status.${invoice.status}`)}</Badge>
                <span className="text-[12px] text-ink-soft">
                  {t('area.admin.billing.invoices.amounts', {
                    total: rupees(invoice.total),
                    paid: rupees(invoice.paid),
                    due: rupees(invoice.outstanding),
                  })}
                </span>
                <span className="ml-auto text-[12px] text-muted">{t('area.admin.billing.invoices.due', { date: invoice.dueDate })}</span>
                <RowButton onClick={() => setOpenId(openId === invoice.id ? null : invoice.id)}>
                  {t('area.admin.billing.invoices.receipts')}
                </RowButton>
              </div>
              {openId === invoice.id && (
                <Receipts token={token} invoiceId={invoice.id} mayReverse={mayReverse} onReverse={reverse.ask} />
              )}
            </div>
          ))}
        </div>
      )}
      {reverse.dialog}
    </Panel>
  )
}

function Receipts({ token, invoiceId, mayReverse, onReverse }: {
  token: string
  invoiceId: string
  mayReverse: boolean
  onReverse: (payment: Payment) => void
}) {
  const { t } = useTranslation()
  const payments = useResource(() => listPayments(token, invoiceId), [token, invoiceId])

  if (payments.loading) return <Skeleton rows={1} />
  if (payments.error) return <ErrorState message={payments.error} onRetry={payments.reload} />
  if (!payments.data?.length) return <p className="text-[12px] text-muted">{t('area.admin.billing.invoices.noReceipts')}</p>

  return (
    <div className="flex flex-col gap-1 rounded-lg bg-canvas p-3">
      {payments.data.map((payment) => (
        <div key={payment.id} className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="font-semibold text-ink">{payment.receiptNumber}</span>
          <span className="text-ink-soft">{rupees(payment.amount)}</span>
          <span className="text-muted">{payment.receivedOn}</span>
          {payment.paidBy && <span className="text-muted">{payment.paidBy}</span>}
          {payment.reversedAt ? (
            <Badge tone="danger">{t('area.admin.billing.invoices.reversed', { reason: payment.reversalReason ?? '' })}</Badge>
          ) : (
            mayReverse && (
              <RowButton tone="danger" onClick={() => onReverse(payment)}>
                {t('area.admin.billing.invoices.reverse')}
              </RowButton>
            )
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * Billing: the rates in force, the invoices they produce and the cash received against them.
 * Each panel is shown only to an Admin who holds the permission printed under its title.
 */
export function BillingPage({ user, accessToken }: { user: AuthUser; accessToken: string }) {
  const { t } = useTranslation()
  const societies = useResource(() => listSocieties(accessToken), [accessToken])
  const societyId = societies.data?.[0]?.id
  const invoices = useResource(societyId ? () => listInvoices(accessToken, societyId) : null, [accessToken, societyId])

  if (societies.loading) return <Skeleton rows={5} />
  if (societies.error) return <ErrorState message={societies.error} onRetry={societies.reload} />
  if (!societyId) {
    return <EmptyState title={t('area.admin.society.noSociety.title')} description={t('area.admin.society.noSociety.description')} />
  }

  const may = (permission: string) => user.permissions.includes(permission as never)

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.admin.nav.billing')}</h1>
        <p className="text-[13px] text-muted">{t('area.admin.billing.intro')}</p>
      </header>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {may('BILLING_RATE_SET') && <RatesPanel token={accessToken} societyId={societyId} />}
        {may('INVOICE_GENERATE') && <GeneratePanel token={accessToken} societyId={societyId} onGenerated={invoices.reload} />}
      </div>

      {may('PAYMENT_CASH_MARK') && <PaymentPanel token={accessToken} invoices={invoices.data ?? []} onPaid={invoices.reload} />}

      <InvoicesPanel
        token={accessToken}
        invoices={invoices.data ?? []}
        loading={invoices.loading}
        error={invoices.error}
        onReload={invoices.reload}
        mayReverse={may('PAYMENT_CASH_MARK')}
      />
    </div>
  )
}
