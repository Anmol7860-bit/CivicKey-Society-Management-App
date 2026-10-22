import { Receipt } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, type Tone } from '../../components/ui/Badge'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States'
import { listMyInvoices, type InvoiceStatus, type MyInvoice } from '../billing/api'
import { Panel } from '../society/parts'
import { useResource } from '../society/useResource'

const TONE: Record<InvoiceStatus, Tone> = { UNPAID: 'warning', PARTIALLY_PAID: 'warning', PAID: 'positive', CANCELLED: 'neutral' }
const rupees = (value: number) => `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const month = (period: string) => new Date(period).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]">
      <span className="text-ink-soft">{label}</span>
      <span className="font-semibold text-ink">{value}</span>
    </div>
  )
}

/** The bill that still owes money, broken down the way the invoice was worked out. */
function CurrentBill({ invoice }: { invoice: MyInvoice }) {
  const { t } = useTranslation()
  return (
    <Panel title={t('area.resident.bills.currentTitle', { month: month(invoice.period) })} description={t('area.resident.bills.due', { date: invoice.dueDate })}>
      <div className="flex flex-col gap-2">
        <Line label={t('area.resident.bills.maintenance')} value={rupees(invoice.maintenance)} />
        {invoice.sinkingFund > 0 && <Line label={t('area.resident.bills.sinkingFund')} value={rupees(invoice.sinkingFund)} />}
        {invoice.parkingCharge > 0 && <Line label={t('area.resident.bills.parking')} value={rupees(invoice.parkingCharge)} />}
        {invoice.oneTimeAmount > 0 && (
          <Line label={invoice.oneTimeDescription ?? t('area.admin.billing.generate.oneTimeDescription')} value={rupees(invoice.oneTimeAmount)} />
        )}
        <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2 text-[15px]">
          <span className="font-bold text-ink">{t('area.resident.bills.total')}</span>
          <span className="font-bold text-ink">{rupees(invoice.total)}</span>
        </div>
        {invoice.paid > 0 && (
          <>
            <Line label={t('area.admin.reports.totals.paid')} value={`− ${rupees(invoice.paid)}`} />
            <Line label={t('area.admin.reports.totals.outstanding')} value={rupees(invoice.outstanding)} />
          </>
        )}
      </div>

      <div className="rounded-xl border border-line bg-canvas p-3">
        <p className="m-0 text-[13px] font-semibold text-ink">{t('area.resident.bills.payTitle')}</p>
        <p className="m-0 mt-1 text-[12px] text-muted">{t('area.resident.bills.payOffline')}</p>
      </div>
    </Panel>
  )
}

/** Bills and receipts for the resident's own flat, read straight from the invoices. */
export function BillsPage({ accessToken }: { accessToken: string }) {
  const { t } = useTranslation()
  const invoices = useResource(() => listMyInvoices(accessToken), [accessToken])

  if (invoices.loading) return <Skeleton rows={5} />
  if (invoices.error) return <ErrorState message={invoices.error} onRetry={invoices.reload} />

  const rows = invoices.data ?? []
  const current = rows.find((invoice) => invoice.status === 'UNPAID' || invoice.status === 'PARTIALLY_PAID')

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.resident.bills.title')}</h1>
        <p className="text-[13px] text-muted">{t('area.resident.bills.intro')}</p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {current ? (
          <CurrentBill invoice={current} />
        ) : (
          <Panel>
            <EmptyState icon={Receipt} title={t('area.resident.bills.settled.title')} description={t('area.resident.bills.settled.description')} />
          </Panel>
        )}

        <Panel title={t('area.resident.bills.historyTitle')} description={t('area.resident.bills.historyDescription')}>
          {rows.length === 0 ? (
            <EmptyState icon={Receipt} title={t('area.resident.bills.empty.title')} description={t('area.resident.bills.empty.description')} />
          ) : (
            <div className="overflow-auto rounded-xl border border-line">
              <table className="w-full border-collapse">
                <thead className="bg-canvas">
                  <tr>
                    {['bill', 'amount', 'status', 'paidOn', 'receipt'].map((column) => (
                      <th key={column} className="px-3 py-2 text-left text-[11px] font-bold tracking-wide text-muted uppercase">
                        {t(`area.resident.bills.columns.${column}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((invoice) => {
                    const settled = invoice.payments.filter((payment) => payment.reversedAt === null)
                    const last = settled[0]
                    return (
                      <tr key={invoice.id} className="border-t border-line">
                        <td className="px-3 py-2 text-[13px] font-semibold text-ink">{month(invoice.period)}</td>
                        <td className="px-3 py-2 text-[13px] text-ink-soft">{rupees(invoice.total)}</td>
                        <td className="px-3 py-2">
                          <Badge tone={TONE[invoice.status]}>{t(`area.admin.reports.values.${invoice.status}`)}</Badge>
                        </td>
                        <td className="px-3 py-2 text-[13px] text-muted">{last?.receivedOn ?? '—'}</td>
                        <td className="px-3 py-2 text-[12px] font-semibold text-ink-soft">{last?.receiptNumber ?? '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
