import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import type { AuthUser, Permission } from '../auth/api'
import { AreaRoute } from './AreaRoute'

// The Admin overview reads its numbers from these; the routing tests only care about the shell
vi.mock('../society/api', async () => ({
  ...(await vi.importActual<typeof import('../society/api')>('../society/api')),
  listSocieties: vi.fn().mockResolvedValue([]),
  listMyFlats: vi.fn().mockResolvedValue([]),
}))
vi.mock('../gate/api', async () => ({
  ...(await vi.importActual<typeof import('../gate/api')>('../gate/api')),
  gateSummary: vi.fn().mockResolvedValue({ waiting: 0, inside: 0, visitorsInside: 0, staffInside: 0, today: 0, expected: 0 }),
  listInside: vi.fn().mockResolvedValue([]),
  listVisits: vi.fn().mockResolvedValue([]),
  listMyVisits: vi.fn().mockResolvedValue([]),
  listMyPasses: vi.fn().mockResolvedValue([]),
  listMyDailyHelp: vi.fn().mockResolvedValue([]),
  listMyVehicles: vi.fn().mockResolvedValue([]),
  listMyAccessRequests: vi.fn().mockResolvedValue([]),
  flatDirectory: vi.fn().mockResolvedValue([]),
}))
vi.mock('../notification/api', async () => ({
  ...(await vi.importActual<typeof import('../notification/api')>('../notification/api')),
  listNotifications: vi.fn().mockResolvedValue({ items: [], unread: 3 }),
}))
vi.mock('../notification/useNotifications', async () => ({
  ...(await vi.importActual<typeof import('../notification/useNotifications')>('../notification/useNotifications')),
  useLiveNotifications: vi.fn(),
}))
vi.mock('../billing/api', async () => ({
  ...(await vi.importActual<typeof import('../billing/api')>('../billing/api')),
  listMyInvoices: vi.fn().mockResolvedValue([]),
  listInvoices: vi.fn().mockResolvedValue([]),
}))

const user = (role: AuthUser['role'], permissions: Permission[]): AuthUser => ({
  id: 'u1',
  name: 'Maya Shah',
  phone: null,
  email: null,
  role,
  societyId: 's1',
  permissions,
})

const RESIDENT: Permission[] = ['VISITOR_APPROVE', 'VISITOR_PASS_CREATE', 'VISIT_VIEW_OWN', 'BILL_VIEW_OWN', 'BILL_PAY', 'RECEIPT_VIEW_OWN']
const GUARD: Permission[] = ['VISIT_REGISTER', 'VISIT_DECIDE', 'VISIT_ENTRY_RECORD', 'VISIT_EXIT', 'PASS_VALIDATE']

function renderAt(path: string, signedIn: AuthUser) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AreaRoute user={signedIn} accessToken="token" onLogout={async () => {}} />
    </MemoryRouter>,
  )
}

function navLabels() {
  return within(screen.getByRole('navigation', { name: 'Main navigation' }))
    .getAllByRole('link')
    .map((link) => link.textContent)
}

describe('role destinations', () => {
  it('gives a Resident their navigation, greeting and actions', () => {
    renderAt('/resident/overview', user('RESIDENT', RESIDENT))

    expect(navLabels()).toEqual(['Overview', 'My flat', 'Visitor approval', 'Daily help', 'Bills & payments', 'Notifications', 'My activity'])
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Good (morning|afternoon|evening), Maya$/)
    // The overview carries no primary action button; Visitor approval is reached from the nav and shortcuts
    expect(screen.queryByRole('link', { name: 'Approve visitor' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Own activity & history' })).toBeInTheDocument()
    // The resident's own feed fills it; a committee member without VISIT_VIEW_OWN sees the empty note
  })

  it('shows the resident how many notices are unread', async () => {
    renderAt('/resident/dashboard', user('RESIDENT', RESIDENT))

    expect(await screen.findByRole('link', { name: 'Notifications, 3 unread' })).toHaveTextContent('3')
  })

  it('gives a Guard gate operations only', () => {
    renderAt('/guard/operations', user('GUARD', GUARD))

    expect(navLabels()).toEqual(['Gate overview', 'Visitor registration', 'Pass validation', 'Gate log', 'Sync status'])
    expect(screen.getByRole('heading', { name: 'Gate operations' })).toBeInTheDocument()
    expect(screen.queryByText(/Bill/)).not.toBeInTheDocument()
  })

  it('gives a committee member only the committee destinations, with no Add user', () => {
    renderAt('/admin/overview', user('ADMIN', ['BILLING_RATE_SET', 'INVOICE_GENERATE', 'PAYMENT_CASH_MARK', 'REPORT_VIEW']))

    // Community tasks needs SOCIETY_MANAGE, which this committee member does not hold
    expect(navLabels()).toEqual(['Overview', 'Billing', 'Reports'])
    expect(screen.queryByRole('link', { name: 'Add user' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Shortcuts' })).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Billing & reportsCollections and exports',
    ])
  })

  it('gives a General Admin every admin destination and Add user', () => {
    renderAt('/admin/overview', user('ADMIN', ['SOCIETY_MANAGE', 'USER_MANAGE', 'GUARD_MANAGE', 'STAFF_MANAGE', 'AUDIT_VIEW']))

    expect(navLabels()).toEqual([
      'Overview',
      'Add user',
      'Society & users',
      'Staff management',
      'Staff movement',
      'Security activity',
      'Community tasks',
    ])
    expect(screen.getAllByRole('link', { name: 'Add user' })[0]).toBeInTheDocument()
  })
})

describe('restricted routes', () => {
  it.each([
    ['another role’s area', '/admin/reports', user('RESIDENT', RESIDENT)],
    ['a page the user lacks permission for', '/admin/society', user('ADMIN', ['REPORT_VIEW'])],
    ['billing, for a Guard', '/admin/billing', user('GUARD', GUARD)],
    ['resident management, for a Guard', '/admin/society', user('GUARD', GUARD)],
    ['a Resident’s bills, for a Guard', '/resident/bills', user('GUARD', GUARD)],
  ])('shows Access Denied for %s and keeps the user’s own navigation', (_case, path, signedIn) => {
    renderAt(path, signedIn)

    expect(screen.getByRole('heading', { name: 'You don’t have access to this area' })).toBeInTheDocument()
    expect(screen.getByText(path)).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument()
  })

  it('offers the way back to the user’s own dashboard', () => {
    renderAt('/guard/operations', user('RESIDENT', RESIDENT))

    expect(screen.getByRole('link', { name: 'Back to Resident dashboard' })).toHaveAttribute('href', '/resident/overview')
  })

  it('sends unknown pages to the home page', () => {
    renderAt('/resident/nope', user('RESIDENT', RESIDENT))

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Maya/)
  })
})

describe('mobile drawer', () => {
  it('opens the same filtered navigation and closes after choosing a page', async () => {
    renderAt('/guard/operations', user('GUARD', GUARD))

    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    const drawer = screen.getByRole('dialog', { name: 'Main navigation' })
    await userEvent.click(within(drawer).getByRole('link', { name: 'Pass validation' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Pass validation, staff verification and the inside list are one gate screen
    expect(screen.getByRole('heading', { name: 'Pass validation, gate and staff' })).toBeInTheDocument()
  })
})
