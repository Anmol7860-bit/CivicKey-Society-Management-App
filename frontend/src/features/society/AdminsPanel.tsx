import { useTranslation } from 'react-i18next'
import { ErrorState, Skeleton } from '../../components/ui/States'
import { issueLoginCode, listAdmins, type LoginCode } from './api'
import { LoginCodeNote, Panel, RowButton, useAction } from './parts'
import { useResource } from './useResource'
import { useState } from 'react'

/**
 * Who holds an Admin account in this society, and what each one may do.
 *
 * Also the only way back to a login code: the code is shown once when the account is made and
 * stored nowhere, so an Admin who lost theirs needs a fresh one issuing here.
 *
 * `reloadKey` lets a caller that just changed an account ask for the list again.
 */
export function AdminsPanel({ accessToken, societyId, reloadKey = 0 }: { accessToken: string; societyId: string; reloadKey?: number }) {
  const { t } = useTranslation()
  const admins = useResource(() => listAdmins(accessToken, societyId), [accessToken, societyId, reloadKey])
  const [loginCode, setLoginCode] = useState<LoginCode | null>(null)
  const action = useAction()

  async function issueCode(userId: string) {
    let issued: LoginCode | null = null
    if (await action.run(async () => { issued = await issueLoginCode(accessToken, userId) })) setLoginCode(issued)
  }

  return (
    <Panel title={t('area.admin.addUser.admin.existing.title')} description={t('area.admin.addUser.admin.existing.description')}>
      {loginCode && <LoginCodeNote loginCode={loginCode} onDismiss={() => setLoginCode(null)} />}
      {action.error && (
        <p className="text-[12px] font-semibold text-red-700" role="alert">
          {action.error}
        </p>
      )}
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
            <span className="ml-auto">
              <RowButton disabled={action.pending} onClick={() => issueCode(admin.id)}>
                {t('area.admin.society.residents.loginCode')}
              </RowButton>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
