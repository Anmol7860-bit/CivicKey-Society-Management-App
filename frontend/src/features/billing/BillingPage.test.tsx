import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuthUser, Permission } from '../auth/api'
import * as societyApi from '../society/api'
import { aSociety } from '../society/fixtures'
import * as api from './api'
import type { BillingRate, Invoice, Payment } from './api'
import { BillingPage } from './BillingPage'

vi.mock('./api')
vi.mock('../society/api', async () => ({
  ...(await vi.importActual<typeof societyApi>('../society/api')),
  listSocieties: vi.fn(),
}))

const mocked = vi.mocked(api)
const society = vi.mocked(societyApi)

const user = (permissions: Permission[]): AuthUser => ({ id: 'u1', name: 'Anita Rao', role: 'ADMIN', permissions, societyId: 's1', phone: '9876543212', email: null })

const rate: BillingRate = {
  id: 'r1',
  societyId: 's1',
  chargeBasis: 'PER_SQFT',
  rate: 3.5,
  sinkingFund: 500,
  parkingCharge: 300,
  dueDay: 10,
  lateFeePerDay: null,
  effectiveFrom: '2026-01-01',
  createdAt: '2026-01-01T00:00:00.000Z',
}

const invoice = (overrides: Partial<Invoice> = {}): Invoice => ({
  id: 'i1',
  flatId: 'fl1',
  period: '2026-02-01',
  maintenance: 3500,
  sinkingFund: 500,
  parkingCharge: 600,
  oneTimeDescription: null,
  oneTimeAmount: 0,
  total: 4600,
  paid: 0,
  outstanding: 4600,
  dueDate: '2026-02-10',
  status: 'UNPAID',
  flat: { id: 'fl1', number: '101', blockName: 'A' },
  ...overrides,
})

const ALL: Permission[] = ['BILLING_RATE_SET', 'INVOICE_GENERATE', 'PAYMENT_CASH_MARK']

function show(permissions: Permission[] = ALL) {
  render(<BillingPage user={user(permissions)} accessToken="token" />)
}

beforeEach(() => {
  vi.resetAllMocks()
  society.listSocieties.mockResolvedValue([aSociety()])
  mocked.listRates.mockResolvedValue([rate])
  mocked.listInvoices.mockResolvedValue([invoice()])
  mocked.listPayments.mockResolvedValue([])
})

it('shows only the panels the Admin holds the permission for', async () => {
  show(['PAYMENT_CASH_MARK'])

  expect(await screen.findByText('Record a cash payment')).toBeInTheDocument()
  expect(screen.queryByText('Maintenance rates')).not.toBeInTheDocument()
  expect(screen.queryByText('Generate invoices')).not.toBeInTheDocument()
})

it('saves the maintenance rates, sending the amounts as numbers', async () => {
  mocked.setRates.mockResolvedValue(rate)
  show()

  await userEvent.type(await screen.findByLabelText(/Rate \(₹\)/), '3.5')
  await userEvent.type(screen.getByLabelText(/Sinking fund/), '500')
  await userEvent.click(screen.getByRole('button', { name: 'Save rates' }))

  await waitFor(() =>
    expect(mocked.setRates).toHaveBeenCalledWith(
      'token',
      's1',
      expect.objectContaining({ chargeBasis: 'PER_SQFT', rate: 3.5, sinkingFund: 500, dueDay: 10 }),
    ),
  )
  expect(await screen.findByText('Rates saved.')).toBeInTheDocument()
})

it('previews the invoices before generating them, and writes nothing on a preview', async () => {
  mocked.previewInvoices.mockResolvedValue({
    period: '2026-02-01',
    dueDate: '2026-02-10',
    rate,
    lines: [{ flatId: 'fl1', flat: 'A-101', maintenance: 3500, sinkingFund: 500, parkingCharge: 600, oneTimeAmount: 0, total: 4600 }],
    skipped: [{ flat: 'A-102', reason: 'No carpet area on the flat' }],
    total: 4600,
  })
  show()

  await userEvent.click(await screen.findByRole('button', { name: 'Preview' }))

  expect(await screen.findByText(/1 invoices · ₹4,600.00 in all/)).toBeInTheDocument()
  expect(screen.getByText(/A-102 \(No carpet area on the flat\)/)).toBeInTheDocument()
  expect(mocked.generateInvoices).not.toHaveBeenCalled()
})

it('generates the invoices for the chosen month, with a one-time charge', async () => {
  mocked.generateInvoices.mockResolvedValue({ period: '2026-02-01', dueDate: '2026-02-10', generated: 12, skipped: [] })
  show()

  await userEvent.type(await screen.findByLabelText(/One-time charge/), 'Lift repair')
  await userEvent.type(screen.getByLabelText(/Amount per flat/), '1200')
  await userEvent.click(screen.getByRole('button', { name: 'Generate invoices' }))

  await waitFor(() =>
    expect(mocked.generateInvoices).toHaveBeenCalledWith(
      'token',
      's1',
      expect.objectContaining({ oneTimeDescription: 'Lift repair', oneTimeAmount: 1200 }),
    ),
  )
  expect(await screen.findByText(/12 invoices generated/)).toBeInTheDocument()
})

it('records a cash payment against the flat’s open invoice and shows the receipt', async () => {
  const payment: Payment = {
    id: 'p1',
    invoiceId: 'i1',
    amount: 4600,
    receivedOn: '2026-02-05',
    paidBy: 'Riya Sharma',
    note: null,
    receiptNumber: 'RCT-2026-000001',
    reversedAt: null,
    reversalReason: null,
    invoice: { status: 'PAID', paid: 4600, outstanding: 0 },
  }
  mocked.recordPayment.mockResolvedValue(payment)
  show()

  // The flat list comes from the invoices, so wait for them before choosing one
  await screen.findByRole('option', { name: 'A-101' })
  await userEvent.selectOptions(screen.getByLabelText(/^Flat \*/), 'fl1')
  await userEvent.selectOptions(screen.getByLabelText(/^Invoice/), 'i1')
  await userEvent.type(screen.getByLabelText(/Amount received/), '4600')
  await userEvent.type(screen.getByLabelText(/Paid by/), 'Riya Sharma')
  await userEvent.click(screen.getByRole('button', { name: 'Record payment and issue receipt' }))

  await waitFor(() =>
    expect(mocked.recordPayment).toHaveBeenCalledWith(
      'token',
      'i1',
      expect.objectContaining({ amount: 4600, paidBy: 'Riya Sharma' }),
    ),
  )
  expect(await screen.findByText(/Receipt RCT-2026-000001 issued for ₹4,600.00/)).toBeInTheDocument()
})

it('lists what is billed and opens the receipts behind an invoice', async () => {
  mocked.listInvoices.mockResolvedValue([invoice({ paid: 1000, outstanding: 3600, status: 'PARTIALLY_PAID' })])
  mocked.listPayments.mockResolvedValue([
    {
      id: 'p1',
      invoiceId: 'i1',
      amount: 1000,
      receivedOn: '2026-02-05',
      paidBy: null,
      note: null,
      receiptNumber: 'RCT-2026-000001',
      reversedAt: null,
      reversalReason: null,
    },
  ])
  show()

  expect(await screen.findByText('Part paid')).toBeInTheDocument()
  expect(screen.getByText(/₹4,600.00 billed · ₹1,000.00 paid · ₹3,600.00 due/)).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Receipts' }))

  expect(await screen.findByText('RCT-2026-000001')).toBeInTheDocument()
  expect(mocked.listPayments).toHaveBeenCalledWith('token', 'i1')
})

it('reverses a receipt with a reason instead of deleting it', async () => {
  mocked.listPayments.mockResolvedValue([
    {
      id: 'p1',
      invoiceId: 'i1',
      amount: 1000,
      receivedOn: '2026-02-05',
      paidBy: null,
      note: null,
      receiptNumber: 'RCT-2026-000001',
      reversedAt: null,
      reversalReason: null,
    },
  ])
  mocked.reversePayment.mockResolvedValue({} as never)
  show()

  await userEvent.click(await screen.findByRole('button', { name: 'Receipts' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Reverse' }))
  await userEvent.type(screen.getByLabelText(/Reason/), 'Cheque bounced')
  await userEvent.click(screen.getByRole('dialog').querySelector('button[type="submit"]')!)

  await waitFor(() => expect(mocked.reversePayment).toHaveBeenCalledWith('token', 'p1', { reason: 'Cheque bounced' }))
})
