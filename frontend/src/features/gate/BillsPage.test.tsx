import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuthUser } from '../auth/api'
import * as api from '../billing/api'
import * as checkout from '../billing/checkout'
import { BillsPage } from './BillsPage'

vi.mock('../billing/api')
vi.mock('../billing/checkout')
const mocked = vi.mocked(api)
const gateway = vi.mocked(checkout)

const resident: AuthUser = {
  id: 'u1',
  name: 'Riya Sharma',
  phone: '9876543210',
  email: null,
  role: 'RESIDENT',
  societyId: 's1',
  permissions: ['BILL_VIEW_OWN', 'BILL_PAY'],
}

const show = () => render(<BillsPage user={resident} accessToken="token" />)

const invoice = (overrides: Partial<api.MyInvoice> = {}): api.MyInvoice =>
  ({
    id: 'i1',
    flatId: 'fl1',
    period: '2026-10-01',
    maintenance: 3325,
    sinkingFund: 500,
    parkingCharge: 300,
    oneTimeDescription: null,
    oneTimeAmount: 0,
    total: 4125,
    paid: 0,
    outstanding: 4125,
    dueDate: '2026-11-10',
    status: 'UNPAID',
    flat: { id: 'fl1', number: '101', blockName: 'A' },
    payments: [],
    ...overrides,
  }) as api.MyInvoice

beforeEach(() => vi.resetAllMocks())

it('breaks the current bill into the parts it was worked out from', async () => {
  mocked.listMyInvoices.mockResolvedValue([invoice()])
  show()

  expect(await screen.findByRole('heading', { name: 'October 2026 maintenance' })).toBeInTheDocument()
  expect(screen.getByText('₹3,325.00')).toBeInTheDocument()
  expect(screen.getAllByText('₹4,125.00')).not.toHaveLength(0)
  expect(screen.getByText('Due 2026-11-10')).toBeInTheDocument()
})

it('lists the receipt against a paid bill', async () => {
  mocked.listMyInvoices.mockResolvedValue([
    invoice({
      id: 'i2',
      period: '2026-09-01',
      status: 'PAID',
      paid: 4125,
      outstanding: 0,
      payments: [{ id: 'pay1', receiptNumber: 'RCT-2026-000001', receivedOn: '2026-09-08', reversedAt: null } as never],
    }),
  ])
  show()

  expect(await screen.findByText('RCT-2026-000001')).toBeInTheDocument()
  expect(screen.getByText('2026-09-08')).toBeInTheDocument()
  // Nothing is owed, so the pay panel gives way to the settled note
  expect(screen.getByRole('heading', { name: 'Nothing due' })).toBeInTheDocument()
})

it('says so before the society has billed anything', async () => {
  mocked.listMyInvoices.mockResolvedValue([])
  show()

  expect(await screen.findByRole('heading', { name: 'No bills yet' })).toBeInTheDocument()
})

it('opens the gateway for the whole outstanding amount, and claims nothing about the result', async () => {
  mocked.listMyInvoices.mockResolvedValue([invoice()])
  mocked.startCheckout.mockResolvedValue({
    attemptId: 'a1',
    orderId: 'order_1',
    amount: 4125,
    currency: 'INR',
    keyId: 'rzp_test_1',
  })
  gateway.openCheckout.mockResolvedValue()
  show()

  await userEvent.click(await screen.findByRole('button', { name: 'Pay ₹4,125.00 now' }))

  await waitFor(() => expect(mocked.startCheckout).toHaveBeenCalledWith('token', 'i1'))
  expect(gateway.openCheckout).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order_1' }), resident)
  // The bill is re-read rather than marked paid: only the webhook settles it
  expect(mocked.listMyInvoices).toHaveBeenCalledTimes(2)
})

it('says what went wrong when the gateway cannot be reached', async () => {
  mocked.listMyInvoices.mockResolvedValue([invoice()])
  mocked.startCheckout.mockRejectedValue(new Error('Online payment is not set up for this society yet.'))
  show()

  await userEvent.click(await screen.findByRole('button', { name: /Pay/ }))

  expect(await screen.findByText('Online payment is not set up for this society yet.')).toBeInTheDocument()
})
