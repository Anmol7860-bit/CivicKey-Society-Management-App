import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States'
import type { AuthUser } from '../auth/api'
import { listBlocks, listSocieties, type Flat, type Society, type VerificationStatus } from './api'
import { BlocksTab } from './BlocksTab'
import { FlatsTab } from './FlatsTab'
import { FloorsTab } from './FloorsTab'
import { Tabs } from './parts'
import { ResidentsTab } from './ResidentsTab'
import { StructureTab } from './StructureTab'
import { useResource } from './useResource'

const TAB_KEYS = ['structure', 'blocks', 'floors', 'flats', 'residents', 'approvals'] as const
type TabKey = (typeof TAB_KEYS)[number]

/**
 * Society & users: everything the Admin does to the society structure and its residents, as tabs
 * inside the one /admin/society destination rather than a second admin dashboard.
 */
export function SocietyPage({ user, accessToken }: { user: AuthUser; accessToken: string }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<TabKey>('structure')
  const [society, setSociety] = useState<Society | null>(null)
  const [blockId, setBlockId] = useState('')
  const [flat, setFlat] = useState<Flat | null>(null)

  const societies = useResource(async () => {
    const rows = await listSocieties(accessToken)
    setSociety((current) => current ?? rows[0] ?? null)
    return rows
  }, [accessToken])

  const current = society ?? societies.data?.[0] ?? null
  const blocks = useResource(current ? () => listBlocks(accessToken, current.id) : null, [accessToken, current?.id, tab])

  // Residents is the directory; Approvals is the same list filtered to what is waiting
  const openResidents = (next: Flat | null, key: TabKey = 'residents') => {
    setFlat(next)
    setTab(key)
  }

  if (societies.loading) return <Skeleton rows={5} />
  if (societies.error) return <ErrorState message={societies.error} onRetry={societies.reload} />
  if (!current) {
    return <EmptyState title={t('area.admin.society.noSociety.title')} description={t('area.admin.society.noSociety.description')} />
  }

  const permitted = TAB_KEYS.filter((key) =>
    key === 'residents' || key === 'approvals' ? user.permissions.includes('USER_MANAGE') : user.permissions.includes('SOCIETY_MANAGE'),
  )
  const active = permitted.includes(tab) ? tab : permitted[0]!

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] leading-7 font-bold text-ink">{t('area.admin.nav.society')}</h1>
        <p className="text-[13px] text-muted">{t('area.admin.society.intro', { name: current.name })}</p>
      </header>

      <Tabs
        tabs={permitted.map((key) => ({ key, label: t(`area.admin.society.tabs.${key}`) }))}
        active={active}
        onSelect={(key) => {
          setTab(key as TabKey)
          if (key !== 'residents') setFlat(null)
        }}
      />

      {active === 'structure' && <StructureTab token={accessToken} society={current} onSocietyChange={setSociety} />}
      {active === 'blocks' && <BlocksTab token={accessToken} societyId={current.id} />}
      {active === 'floors' && (
        <FloorsTab token={accessToken} blocks={blocks.data ?? []} blockId={blockId} onBlockChange={setBlockId} />
      )}
      {active === 'flats' && (
        <FlatsTab
          token={accessToken}
          blocks={blocks.data ?? []}
          blockId={blockId}
          onBlockChange={setBlockId}
          onManageResidents={(chosen) => openResidents(chosen)}
        />
      )}
      {(active === 'residents' || active === 'approvals') && (
        <ResidentsTab
          key={active}
          token={accessToken}
          societyId={current.id}
          flat={active === 'residents' ? flat : null}
          onClearFlat={() => setFlat(null)}
          initialStatus={active === 'approvals' ? ('PENDING' as VerificationStatus) : ''}
        />
      )}
    </div>
  )
}
