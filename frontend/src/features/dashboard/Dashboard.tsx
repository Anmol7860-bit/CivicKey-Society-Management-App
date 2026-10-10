import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { areaByRole, type AuthUser, type Permission } from '../auth/api'

/**
 * Every dashboard function and the permission that unlocks it. The UI only hides what the user
 * can't use; the backend checks the same permission on each operation.
 */
const FUNCTIONS: Array<{ key: string; permission: Permission }> = [
  // Guard
  { key: 'visitorRegister', permission: 'VISITOR_REGISTER' },
  { key: 'visitDecide', permission: 'VISIT_DECIDE' },
  { key: 'visitEntry', permission: 'VISIT_ENTRY_RECORD' },
  { key: 'visitExit', permission: 'VISIT_EXIT_RECORD' },
  { key: 'passValidate', permission: 'PASS_VALIDATE' },
  // Resident
  { key: 'visitorApprove', permission: 'VISITOR_APPROVE' },
  { key: 'visitorPass', permission: 'VISITOR_PASS_CREATE' },
  { key: 'ownVisits', permission: 'OWN_VISITS_VIEW' },
  { key: 'ownBills', permission: 'OWN_BILLS_VIEW' },
  { key: 'payBill', permission: 'OWN_BILL_PAY' },
  { key: 'ownReceipts', permission: 'OWN_RECEIPTS_VIEW' },
  // General Admin
  { key: 'society', permission: 'SOCIETY_MANAGE' },
  { key: 'users', permission: 'USER_MANAGE' },
  { key: 'guards', permission: 'GUARD_MANAGE' },
  { key: 'staff', permission: 'STAFF_MANAGE' },
  { key: 'audit', permission: 'AUDIT_VIEW' },
  // Committee
  { key: 'billingRates', permission: 'BILLING_RATE_SET' },
  { key: 'invoices', permission: 'INVOICE_GENERATE' },
  { key: 'cashPayments', permission: 'PAYMENT_CASH_MARK' },
  { key: 'reports', permission: 'REPORT_VIEW' },
]

export function Dashboard({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const { t } = useTranslation()
  const [pending, setPending] = useState(false)
  const area = areaByRole[user.role]
  const functions = FUNCTIONS.filter(({ permission }) => user.permissions.includes(permission))

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6" data-area={area}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-ink">{t(`shell.${area}.title`)}</h1>
          <p className="text-muted">
            {t('shell.signedInAs', { name: user.name })}
            {user.residentType && (
              <span className="ml-2 rounded-full bg-brand/10 px-2 py-0.5 text-[13px] font-semibold text-brand">
                {t(`shell.residentType.${user.residentType}`)}
              </span>
            )}
          </p>
        </div>
        <div className="w-40">
          <Button
            disabled={pending}
            onClick={() => {
              setPending(true)
              void onLogout()
            }}
          >
            {pending ? t('shell.loggingOut') : t('shell.logout')}
          </Button>
        </div>
      </header>

      {functions.length > 0 ? (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={t('shell.functions')}>
          {functions.map(({ key }) => (
            // ponytail: tiles are labels until each function's page ships; make them links then
            <li key={key} className="rounded-xl border border-line bg-white p-4 shadow-card">
              <h2 className="font-semibold text-ink">{t(`shell.function.${key}`)}</h2>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-line bg-white p-4 text-muted">{t('shell.noFunctions')}</p>
      )}
    </main>
  )
}
