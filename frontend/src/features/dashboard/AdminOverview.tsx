import { useTranslation } from 'react-i18next'
import { ErrorState, Skeleton } from '../../components/ui/States'
import type { AuthUser, Permission } from '../auth/api'
import { listInvoices, type Invoice } from '../billing/api'
import { getOccupancy, listResidents, listSocieties, type Occupancy, type Resident } from '../society/api'
import { Panel } from '../society/parts'
import { useResource } from '../society/useResource'
import { listStaff, type Staff, type StaffKind } from '../staff/api'

const KINDS: StaffKind[] = ['GUARD', 'DAILY_HELP', 'VENDOR']
const thisMonth = () => new Date().toISOString().slice(0, 7)
const today = () => new Date().toISOString().slice(0, 10)
const has = (user: AuthUser, ...permissions: Permission[]) => permissions.some((code) => user.permissions.includes(code))
const rupees = (value: number) => `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

/** Flats and how many of them are lived in, per block: "20 of 50 in Block A". */
function byBlock(occupancy: Occupancy) {
  return occupancy.blocks.map((block) => {
    const flats = block.floors.flatMap((floor) => floor.flats).filter((flat) => flat.status === 'ACTIVE')
    const occupied = flats.filter((flat) => flat.occupancy !== 'VACANT').length
    return { id: block.id, name: block.name, flats: flats.length, occupied, vacant: flats.length - occupied }
  })
}

function countPeople(residents: Resident[]) {
  const living = residents.filter((resident) => resident.active)
  return {
    living: living.length,
    owners: living.filter((resident) => resident.residentType === 'OWNER').length,
    tenants: living.filter((resident) => resident.residentType === 'TENANT').length,
    waiting: residents.filter((resident) => resident.verificationStatus === 'PENDING').length,
  }
}

function countStaff(members: Staff[]) {
  return { total: members.length, ...Object.fromEntries(KINDS.map((kind) => [kind, members.filter((member) => member.kind === kind).length])) } as {
    total: number
  } & Record<StaffKind, number>
}

/** This month at a glance: what was raised, what came in, and what is already late. */
function countMoney(invoices: Invoice[]) {
  const open = invoices.filter((invoice) => invoice.status !== 'PAID' && invoice.status !== 'CANCELLED')
  const total = (rows: Invoice[], pick: (invoice: Invoice) => number) => Number(rows.reduce((sum, row) => sum + pick(row), 0).toFixed(2))
  return {
    invoices: invoices.length,
    billed: total(invoices, (invoice) => invoice.total),
    collected: total(invoices, (invoice) => invoice.paid),
    outstanding: total(invoices, (invoice) => invoice.outstanding),
    unpaid: open.length,
    overdue: total(
      open.filter((invoice) => invoice.dueDate < today()),
      (invoice) => invoice.outstanding,
    ),
  }
}

/**
 * Every number on the Admin's overview, read from the APIs each feature already exposes. Each
 * call is skipped unless the Admin holds the permission the endpoint itself requires.
 */
export function useAdminSummary(user: AuthUser, accessToken: string) {
  const enabled = user.role === 'ADMIN'
  const societies = useResource(enabled ? () => listSocieties(accessToken) : null, [accessToken, enabled])
  const societyId = societies.data?.[0]?.id

  const occupancy = useResource(
    societyId && has(user, 'SOCIETY_MANAGE') ? () => getOccupancy(accessToken, societyId) : null,
    [accessToken, societyId],
  )
  const residents = useResource(
    societyId && has(user, 'USER_MANAGE') ? () => listResidents(accessToken, societyId) : null,
    [accessToken, societyId],
  )
  const staff = useResource(
    societyId && has(user, 'GUARD_MANAGE', 'STAFF_MANAGE') ? () => listStaff(accessToken, societyId, { status: 'ACTIVE' }) : null,
    [accessToken, societyId],
  )
  const invoices = useResource(
    societyId && has(user, 'INVOICE_GENERATE', 'PAYMENT_CASH_MARK', 'REPORT_VIEW')
      ? () => listInvoices(accessToken, societyId, { period: thisMonth() })
      : null,
    [accessToken, societyId],
  )

  return {
    societies,
    occupancy,
    residents,
    staff,
    invoices,
    blocks: occupancy.data ? byBlock(occupancy.data) : null,
    people: residents.data ? countPeople(residents.data) : null,
    staffCount: staff.data ? countStaff(staff.data) : null,
    money: invoices.data ? countMoney(invoices.data) : null,
  }
}

export type AdminSummary = ReturnType<typeof useAdminSummary>

/** The headline on one of the three summary cards, or a dash while it loads. */
export function AdminStat({ statKey, summary }: { statKey: string; summary: AdminSummary }) {
  const { t } = useTranslation()
  const { people, staffCount, money } = summary
  const totals = summary.occupancy.data?.summary

  const card: Record<string, { value: string; hint: string } | null> = {
    occupancy: totals
      ? {
          value: t('area.admin.overview.ofFlats', { occupied: totals.occupied, flats: totals.flats }),
          hint: t('area.admin.overview.vacantHint', { count: totals.vacant }),
        }
      : null,
    users:
      people || staffCount
        ? {
            value: t('area.admin.overview.peopleValue', { residents: people?.living ?? 0, staff: staffCount?.total ?? 0 }),
            hint: staffCount
              ? t('area.admin.overview.staffHint', {
                  guards: staffCount.GUARD,
                  help: staffCount.DAILY_HELP,
                  vendors: staffCount.VENDOR,
                })
              : t('area.admin.overview.waitingHint', { count: people?.waiting ?? 0 }),
          }
        : null,
    billing: money
      ? {
          value: rupees(money.outstanding),
          hint: t('area.admin.overview.collectedHint', { collected: rupees(money.collected), billed: rupees(money.billed) }),
        }
      : null,
  }

  const shown = card[statKey] ?? null
  if (!shown) {
    return (
      <>
        <p className="text-lg text-ink">—</p>
        <p className="text-[10px] text-muted">{t('shell.noData')}</p>
      </>
    )
  }
  return (
    <>
      <p className="text-lg text-ink">{shown.value}</p>
      <p className="text-[10px] text-muted">{shown.hint}</p>
    </>
  )
}

function Tiles({ tiles }: { tiles: [string, string | number][] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map(([label, value]) => (
        <div key={label} className="rounded-xl border border-line p-3">
          <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</p>
          <p className="text-[22px] font-bold text-ink">{value}</p>
        </div>
      ))}
    </div>
  )
}

/** The detail behind the three cards: occupancy per block, who is here, and the month's money. */
export function AdminPanels({ summary }: { summary: AdminSummary }) {
  const { t } = useTranslation()
  const { occupancy, residents, staff, invoices, blocks, people, staffCount, money } = summary

  return (
    <div className="flex flex-col gap-3">
      {occupancy.loading || occupancy.data || occupancy.error ? (
        <Panel title={t('area.admin.overview.occupancy.title')} description={t('area.admin.overview.occupancy.description')}>
          {occupancy.loading ? (
            <Skeleton rows={3} />
          ) : occupancy.error ? (
            <ErrorState message={occupancy.error} onRetry={occupancy.reload} />
          ) : (
            occupancy.data && (
              <>
                <Tiles
                  tiles={(['flats', 'owned', 'unsold', 'occupied', 'vacant', 'sharingAvailable'] as const).map((key) => [
                    t(`area.admin.society.summary.${key}`),
                    occupancy.data!.summary[key],
                  ])}
                />
                {blocks && blocks.length > 0 && (
                  <div className="overflow-hidden rounded-xl border border-line">
                    {blocks.map((block) => (
                      <div key={block.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2.5 first:border-t-0">
                        <span className="w-24 text-[14px] font-semibold text-ink">{block.name}</span>
                        <span className="text-[13px] text-ink-soft">
                          {t('area.admin.overview.blockLine', { occupied: block.occupied, flats: block.flats })}
                        </span>
                        {/* The share occupied, so a half-empty block is visible without reading the numbers */}
                        <span className="h-2 w-28 overflow-hidden rounded-full bg-canvas" aria-hidden>
                          <span
                            className="block h-full rounded-full bg-brand"
                            style={{ width: `${block.flats ? Math.round((block.occupied / block.flats) * 100) : 0}%` }}
                          />
                        </span>
                        <span className="ml-auto text-[12px] text-muted">
                          {t('area.admin.overview.vacantHint', { count: block.vacant })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )
          )}
        </Panel>
      ) : null}

      {(residents.loading || residents.data || staff.loading || staff.data) && (
        <Panel title={t('area.admin.overview.people.title')} description={t('area.admin.overview.people.description')}>
          {residents.loading || staff.loading ? (
            <Skeleton rows={2} />
          ) : (
            <Tiles
              tiles={[
                ...(people
                  ? ([
                      [t('area.admin.overview.people.living'), people.living],
                      [t('area.admin.overview.people.owners'), people.owners],
                      [t('area.admin.overview.people.tenants'), people.tenants],
                      [t('area.admin.overview.people.waiting'), people.waiting],
                    ] as [string, number][])
                  : []),
                ...(staffCount
                  ? (KINDS.map((kind) => [t(`area.admin.staff.kinds.${kind}`), staffCount[kind]]) as [string, number][])
                  : []),
              ]}
            />
          )}
          {residents.error && <ErrorState message={residents.error} onRetry={residents.reload} />}
          {staff.error && <ErrorState message={staff.error} onRetry={staff.reload} />}
        </Panel>
      )}

      {(invoices.loading || invoices.data || invoices.error) && (
        <Panel title={t('area.admin.overview.money.title')} description={t('area.admin.overview.money.description')}>
          {invoices.loading ? (
            <Skeleton rows={2} />
          ) : invoices.error ? (
            <ErrorState message={invoices.error} onRetry={invoices.reload} />
          ) : money && money.invoices === 0 ? (
            <p className="text-[13px] text-muted">{t('area.admin.overview.money.notGenerated')}</p>
          ) : (
            money && (
              <>
                <Tiles
                  tiles={[
                    [t('area.admin.reports.totals.billed'), rupees(money.billed)],
                    [t('area.admin.reports.totals.paid'), rupees(money.collected)],
                    [t('area.admin.reports.totals.outstanding'), rupees(money.outstanding)],
                    [t('area.admin.overview.money.invoices'), money.invoices],
                    [t('area.admin.overview.money.unpaid'), money.unpaid],
                    [t('area.admin.overview.money.overdue'), rupees(money.overdue)],
                  ]}
                />
                <p className="text-[12px] text-muted">
                  {t('area.admin.overview.money.collectedShare', {
                    percent: money.billed ? Math.round((money.collected / money.billed) * 100) : 0,
                  })}
                </p>
              </>
            )
          )}
        </Panel>
      )}
    </div>
  )
}
