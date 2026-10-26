import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import * as billing from '../billing/api'
import type { MyInvoice } from '../billing/api'
import * as gate from '../gate/api'
import * as notification from '../notification/api'
import type { Notification } from '../notification/api'
import type { AccessRequest, Visit, VisitorPass } from '../gate/api'
import type { AuthUser } from '../auth/api'
import { ActivityPage } from './ActivityPage'
import { NotificationsPage } from './NotificationsPage'

vi.mock('../gate/api')
vi.mock('../billing/api')
vi.mock('../notification/api')
const gateApi = vi.mocked(gate)
const billingApi = vi.mocked(billing)
const notificationApi = vi.mocked(notification)

const user: AuthUser = {
  id: 'u1',
  name: 'Riya Sharma',
  phone: '9876543210',
  email: null,
  role: 'RESIDENT',
  societyId: 's1',
  permissions: ['VISIT_VIEW_OWN', 'BILL_VIEW_OWN'],
}

const flat = { number: '101', blockName: 'A', floorLabel: '1st Floor', label: 'A-101' }

const visit = (overrides: Partial<Visit> = {}): Visit => ({
  id: 'v1',
  societyId: 's1',
  gateId: null,
  flatId: 'fl1',
  passId: null,
  visitorName: 'Amit Kulkarni',
  visitorPhone: '9870000001',
  purpose: 'GUEST',
  company: null,
  people: 1,
  vehicleNumber: null,
  note: null,
  photoReference: null,
  status: 'AWAITING_APPROVAL',
  decidedAt: null,
  decisionReason: null,
  enteredAt: null,
  exitedAt: null,
  createdAt: '2026-10-23T10:00:00.000Z',
  flat,
  gateName: 'Main gate',
  registeredByName: 'Mahesh Patil',
  passCode: null,
  ...overrides,
})

const pass = (overrides: Partial<VisitorPass> = {}): VisitorPass => ({
  id: 'p1',
  flatId: 'fl1',
  visitorName: 'Mahesh the plumber',
  visitorPhone: '9870000002',
  purpose: 'SERVICE',
  people: 1,
  validOn: '2026-10-22',
  validFrom: '09:00',
  validUntil: '18:00',
  vehicleNumber: null,
  passType: 'ONE_ENTRY',
  note: null,
  entryCode: '482913',
  status: 'ACTIVE',
  usedAt: null,
  createdAt: '2026-10-22T06:00:00.000Z',
  ...overrides,
})

const invoice = (overrides: Partial<MyInvoice> = {}): MyInvoice => ({
  id: 'i1',
  flatId: 'fl1',
  period: '2026-10-01',
  maintenance: 3000,
  sinkingFund: 500,
  parkingCharge: 625,
  oneTimeDescription: null,
  oneTimeAmount: 0,
  total: 4125,
  paid: 0,
  outstanding: 4125,
  dueDate: '2026-10-15',
  status: 'UNPAID',
  flat: { id: 'fl1', number: '101', blockName: 'A' },
  payments: [],
  ...overrides,
})

const request = (overrides: Partial<AccessRequest> = {}): AccessRequest => ({
  id: 'ar1',
  flatId: 'fl1',
  kind: 'DAILY_HELP',
  name: 'Kamala Bai',
  phone: '9870000003',
  relationship: null,
  accessLevel: null,
  timings: '6-8 pm',
  status: 'APPROVED',
  decidedAt: '2026-10-21T09:00:00.000Z',
  decisionReason: null,
  createdAt: '2026-10-20T09:00:00.000Z',
  ...overrides,
})

function showActivity() {
  render(
    <MemoryRouter>
      <ActivityPage user={user} accessToken="token" />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  gateApi.listMyVisits.mockResolvedValue([visit()])
  gateApi.listMyPasses.mockResolvedValue([pass()])
  gateApi.listMyAccessRequests.mockResolvedValue([request()])
  billingApi.listMyInvoices.mockResolvedValue([invoice()])
})

describe('My activity', () => {
  it('puts visitors, passes, bills and requests on one timeline, newest first', async () => {
    showActivity()

    expect(await screen.findByText(/Amit Kulkarni is at the gate/)).toBeInTheDocument()
    expect(screen.getByText(/You made a pass for Mahesh the plumber, code 482913/)).toBeInTheDocument()
    expect(screen.getByText(/Your October 2026 bill of ₹4125 is due/)).toBeInTheDocument()
    expect(screen.getByText('The office approved Kamala Bai')).toBeInTheDocument()

    // Newest first: the waiting visitor on 23 Oct comes before the pass made on 22 Oct
    const text = document.body.textContent ?? ''
    expect(text.indexOf('Amit Kulkarni')).toBeLessThan(text.indexOf('Mahesh the plumber'))
  })

  it('narrows the timeline to one kind', async () => {
    showActivity()
    await screen.findByText(/Amit Kulkarni/)

    await userEvent.click(screen.getByRole('button', { name: 'Bills (1)' }))

    expect(screen.getByText(/Your October 2026 bill/)).toBeInTheDocument()
    expect(screen.queryByText(/Amit Kulkarni/)).not.toBeInTheDocument()
  })

  it('counts a reversed payment as its own event', async () => {
    billingApi.listMyInvoices.mockResolvedValue([
      invoice({
        status: 'PAID',
        paid: 4125,
        outstanding: 0,
        payments: [
          {
            id: 'pay1',
            invoiceId: 'i1',
            amount: 2000,
            receivedOn: '2026-10-12',
            paidBy: null,
            note: null,
            receiptNumber: 'RCT-2026-000002',
            reversedAt: '2026-10-13T05:00:00.000Z',
            reversalReason: 'Cheque bounced',
          },
        ],
      }),
    ])
    showActivity()

    expect(await screen.findByText(/Payment of ₹2000 was reversed, receipt RCT-2026-000002/)).toBeInTheDocument()
  })

  it('says so when nothing has happened', async () => {
    gateApi.listMyVisits.mockResolvedValue([])
    gateApi.listMyPasses.mockResolvedValue([])
    gateApi.listMyAccessRequests.mockResolvedValue([])
    billingApi.listMyInvoices.mockResolvedValue([])
    showActivity()

    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument()
  })
})

describe('Notifications', () => {
  function showNotifications() {
    render(
      <MemoryRouter>
        <NotificationsPage user={user} accessToken="token" />
      </MemoryRouter>,
    )
  }

  const notice = (overrides: Partial<Notification> = {}): Notification => ({
    id: 'n1',
    eventType: 'VISITOR_WAITING_APPROVAL',
    entityType: 'visit',
    entityId: 'v1',
    title: 'Amit Kulkarni is at your gate',
    body: 'Approve or deny the visit from the visitors page.',
    readAt: null,
    createdAt: '2026-10-23T10:00:00.000Z',
    ...overrides,
  })

  beforeEach(() => {
    notificationApi.listNotifications.mockResolvedValue({ items: [notice()], unread: 1 })
    notificationApi.markAllRead.mockResolvedValue({ marked: 1 })
  })

  it('separates what needs an answer from what was sent', async () => {
    showNotifications()

    const pending = (await screen.findByText('Needs your attention')).closest('section')!
    expect(within(pending).getByText(/Amit Kulkarni is at the gate/)).toBeInTheDocument()
    expect(within(pending).getByText(/Your October 2026 bill/)).toBeInTheDocument()

    const sent = screen.getByText('Sent to you').closest('section')!
    expect(within(sent).getByText('Amit Kulkarni is at your gate')).toBeInTheDocument()
  })

  it('marks everything read on the server, not in this browser', async () => {
    showNotifications()

    await userEvent.click(await screen.findByRole('button', { name: 'Mark 1 as read' }))

    expect(notificationApi.markAllRead).toHaveBeenCalledWith('token')
  })

  it('says when nothing is waiting on the resident', async () => {
    gateApi.listMyVisits.mockResolvedValue([visit({ status: 'CLOSED', exitedAt: '2026-10-23T12:00:00.000Z' })])
    billingApi.listMyInvoices.mockResolvedValue([invoice({ status: 'PAID', paid: 4125, outstanding: 0 })])
    notificationApi.listNotifications.mockResolvedValue({ items: [], unread: 0 })
    showNotifications()

    expect(await screen.findByText('Nothing waiting on you')).toBeInTheDocument()
    expect(await screen.findByText('Nothing to show')).toBeInTheDocument()
  })
})
