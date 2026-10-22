import { render, screen } from '@testing-library/react'
import * as api from '../billing/api'
import { BillsPage } from './BillsPage'

vi.mock('../billing/api')
const mocked = vi.mocked(api)

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
  render(<BillsPage accessToken="token" />)

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
  render(<BillsPage accessToken="token" />)

  expect(await screen.findByText('RCT-2026-000001')).toBeInTheDocument()
  expect(screen.getByText('2026-09-08')).toBeInTheDocument()
  // Nothing is owed, so the pay panel gives way to the settled note
  expect(screen.getByRole('heading', { name: 'Nothing due' })).toBeInTheDocument()
})

it('says so before the society has billed anything', async () => {
  mocked.listMyInvoices.mockResolvedValue([])
  render(<BillsPage accessToken="token" />)

  expect(await screen.findByRole('heading', { name: 'No bills yet' })).toBeInTheDocument()
})
