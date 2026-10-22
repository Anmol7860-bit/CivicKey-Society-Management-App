import { ChartNoAxesCombined } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States'
import { listSocieties } from '../society/api'
import { Panel, RowButton, useAction } from '../society/parts'
import { useResource } from '../society/useResource'
import { downloadReport, runReport, type Report, type ReportName } from './api'

const REPORTS: ReportName[] = ['COLLECTIONS', 'OCCUPANCY']
const thisMonth = () => new Date().toISOString().slice(0, 7)

/** Numbers are right-aligned and rupee-formatted; everything else prints as it comes. */
function Cell({ column, value }: { column: string; value: string | number | null }) {
  const { t } = useTranslation()
  const money = ['billed', 'paid', 'outstanding'].includes(column)
  if (value === null || value === '') return <td className="px-3 py-2 text-[13px] text-subtle">—</td>
  if (money) {
    return (
      <td className="px-3 py-2 text-right text-[13px] font-semibold text-ink">
        ₹{Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </td>
    )
  }
  const label =
    column === 'status' || column === 'occupancy' ? t(`area.admin.reports.values.${value}`, { defaultValue: String(value) }) : String(value)
  return <td className="px-3 py-2 text-[13px] text-ink-soft">{label}</td>
}

/** Reports: the same rows on screen and in the CSV, read back from the invoices and assignments. */
export function ReportsPage({ accessToken }: { accessToken: string }) {
  const { t } = useTranslation()
  const [form, setForm] = useState({ report: 'COLLECTIONS' as ReportName, period: thisMonth() })
  const [report, setReport] = useState<Report | null>(null)
  const action = useAction()
  const download = useAction()

  const societies = useResource(() => listSocieties(accessToken), [accessToken])
  const societyId = societies.data?.[0]?.id

  // Occupancy is a snapshot of today, so a period would mean nothing for it
  const query = () => ({ report: form.report, ...(form.report === 'COLLECTIONS' && form.period ? { period: form.period } : {}) })

  if (societies.loading) return <Skeleton rows={4} />
  if (societies.error) return <ErrorState message={societies.error} onRetry={societies.reload} />
  if (!societyId) {
    return <EmptyState title={t('area.admin.society.noSociety.title')} description={t('area.admin.society.noSociety.description')} />
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.admin.nav.reports')}</h1>
        <p className="text-[13px] text-muted">{t('area.admin.reports.intro')}</p>
      </header>

      <Panel title={t('area.admin.reports.title')} description={t('area.admin.reports.permission')}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <Select
              id="report-name"
              label={t('area.admin.reports.report')}
              options={REPORTS.map((value) => ({ value, label: t(`area.admin.reports.names.${value}`) }))}
              value={form.report}
              onChange={(event) => {
                setForm({ ...form, report: event.target.value as ReportName })
                setReport(null)
              }}
            />
          </div>
          {form.report === 'COLLECTIONS' && (
            <div className="min-w-[180px] flex-1">
              <Select
                id="report-period"
                label={t('area.admin.reports.period')}
                options={[
                  { value: thisMonth(), label: t('area.admin.reports.thisMonth') },
                  { value: lastMonth(), label: t('area.admin.reports.lastMonth') },
                ]}
                placeholder={t('area.admin.reports.allTime')}
                value={form.period}
                onChange={(event) => setForm({ ...form, period: event.target.value })}
              />
            </div>
          )}
          <RowButton
            disabled={download.pending}
            onClick={() => download.run(() => downloadReport(accessToken, societyId, query()))}
          >
            {t('area.admin.reports.download')}
          </RowButton>
          <div className="w-[160px]">
            <Button
              type="button"
              disabled={action.pending}
              onClick={() => action.run(async () => setReport(await runReport(accessToken, societyId, query())))}
            >
              {action.pending ? t('shell.loading') : t('area.admin.reports.view')}
            </Button>
          </div>
        </div>

        {(action.error || download.error) && <ErrorState message={(action.error ?? download.error)!} />}

        {report &&
          (report.rows.length === 0 ? (
            <EmptyState icon={ChartNoAxesCombined} title={t('area.admin.reports.empty.title')} description={t('area.admin.reports.empty.description')} />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-3">
                {Object.entries(report.totals).map(([key, value]) => (
                  <div key={key} className="rounded-xl border border-line px-3 py-2">
                    <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t(`area.admin.reports.totals.${key}`)}</p>
                    <p className="text-[18px] font-bold text-ink">
                      {['billed', 'paid', 'outstanding'].includes(key)
                        ? `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : value}
                    </p>
                  </div>
                ))}
              </div>
              <div className="overflow-auto rounded-xl border border-line">
                <table className="w-full border-collapse">
                  <thead className="bg-canvas">
                    <tr>
                      {report.columns.map((column) => (
                        <th key={column} className="px-3 py-2 text-left text-[11px] font-bold tracking-wide text-muted uppercase">
                          {t(`area.admin.reports.columns.${column}`, { defaultValue: column })}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row, index) => (
                      <tr key={index} className="border-t border-line">
                        {report.columns.map((column) => (
                          <Cell key={column} column={column} value={row[column] ?? null} />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
      </Panel>
    </div>
  )
}

function lastMonth() {
  const date = new Date()
  date.setDate(1)
  date.setMonth(date.getMonth() - 1)
  return date.toISOString().slice(0, 7)
}
