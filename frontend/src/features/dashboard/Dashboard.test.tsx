import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { AuthUser, Permission } from '../auth/api'
import * as billingApi from '../billing/api'
import * as societyApi from '../society/api'
import { aFlat, aSociety } from '../society/fixtures'
import * as staffApi from '../staff/api'
import { Dashboard } from './Dashboard'

vi.mock('../billing/api')
vi.mock('../staff/api')
vi.mock('../society/api', async () => ({
  ...(await vi.importActual<typeof societyApi>('../society/api')),
  listSocieties: vi.fn(),
  getOccupancy: vi.fn(),
  listResidents: vi.fn(),
}))

const society = vi.mocked(societyApi)
const billing = vi.mocked(billingApi)
const staff = vi.mocked(staffApi)

const ALL: Permission[] = ['SOCIETY_MANAGE', 'USER_MANAGE', 'GUARD_MANAGE', 'STAFF_MANAGE', 'INVOICE_GENERATE', 'PAYMENT_CASH_MARK']

const admin = (permissions: Permission[] = ALL): AuthUser => ({
  id: 'u1',
  name: 'Anita Rao',
  phone: '9876543212',
  email: null,
  role: 'ADMIN',
  societyId: 's1',
  permissions,
})

const resident = (overrides: Partial<societyApi.Resident>): societyApi.Resident =>
  ({
    id: 'r1',
    flatId: 'fl1',
    userId: 'u2',
    residentType: 'OWNER',
    accessLevel: 'FULL',
    startDate: '2026-01-01',
    endDate: null,
    verificationStatus: 'VERIFIED',
    verifiedAt: null,
    rejectedReason: null,
    idDocumentType: null,
    idDocumentLast4: null,
    proofReference: null,
    relationship: null,
    idDocumentOnFile: false,
    user: { id: 'u2', name: 'Riya Sharma', phone: '9876543210', email: null },
    active: true,
    eligible: true,
    ...overrides,
  }) as societyApi.Resident

const member = (overrides: Partial<staffApi.Staff>) => ({ id: 's1', kind: 'GUARD', name: 'Ramesh', status: 'ACTIVE', ...overrides }) as staffApi.Staff

const invoice = (overrides: Partial<billingApi.Invoice>) =>
  ({ id: 'i1', total: 4125, paid: 0, outstanding: 4125, dueDate: '2099-12-10', status: 'UNPAID', ...overrides }) as billingApi.Invoice

beforeEach(() => {
  vi.resetAllMocks()
  society.listSocieties.mockResolvedValue([aSociety()])
  society.getOccupancy.mockResolvedValue({
    society: { id: 's1', name: 'Green Meadows' },
    summary: { flats: 3, inactive: 0, unsold: 1, owned: 2, vacant: 1, occupied: 2, sharingAvailable: 0 },
    blocks: [
      {
        id: 'b1',
        societyId: 's1',
        name: 'A',
        status: 'ACTIVE',
        floors: [
          {
            id: 'f1',
            blockId: 'b1',
            floorLabel: '1st Floor',
            sortOrder: null,
            status: 'ACTIVE',
            flats: [aFlat({ id: 'fl1', occupancy: 'FULL' }), aFlat({ id: 'fl2', number: '102' })],
          },
        ],
      },
    ],
  } as societyApi.Occupancy)
  society.listResidents.mockResolvedValue([
    resident({}),
    resident({ id: 'r2', residentType: 'TENANT' }),
    resident({ id: 'r3', verificationStatus: 'PENDING', active: false, eligible: false }),
  ])
  staff.listStaff.mockResolvedValue({ total: 2, staff: [member({}), member({ id: 's2', kind: 'DAILY_HELP', name: 'Sunita' })] })
  billing.listInvoices.mockResolvedValue([invoice({}), invoice({ id: 'i2', paid: 2000, outstanding: 3440, total: 5440, status: 'PARTIALLY_PAID' })])
})

const show = (user = admin()) =>
  render(
    <MemoryRouter>
      <Dashboard user={user} accessToken="token" />
    </MemoryRouter>,
  )

it('heads each card with the live number behind it', async () => {
  show()

  expect(await screen.findByText('2 of 3')).toBeInTheDocument()
  expect(screen.getByText('2 residents · 2 staff')).toBeInTheDocument()
  expect(screen.getByText('1 guards · 1 daily help · 0 vendors')).toBeInTheDocument()
  // Outstanding leads the billing card, and repeats as a tile in the panel below
  expect(screen.getAllByText('₹7,565')).toHaveLength(2)
  expect(screen.getByText('₹2,000 collected of ₹9,565')).toBeInTheDocument()
})

it('breaks occupancy down per block', async () => {
  show()

  expect(await screen.findByText('1 of 2 flats occupied')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Society occupancy' })).toBeInTheDocument()
})

it('counts owners, tenants, approvals and each kind of staff', async () => {
  show()

  const people = (await screen.findByRole('heading', { name: 'Users and staff' })).closest('section')!
  expect(people.textContent).toContain('Living here')
  expect(people.textContent).toContain('Awaiting approval')
  expect(people.textContent).toContain('Daily help')
})

it('asks only for what the Admin may see', async () => {
  show(admin(['GUARD_MANAGE']))

  await screen.findByRole('heading', { name: 'Users and staff' })
  expect(society.getOccupancy).not.toHaveBeenCalled()
  expect(society.listResidents).not.toHaveBeenCalled()
  expect(billing.listInvoices).not.toHaveBeenCalled()
  expect(staff.listStaff).toHaveBeenCalled()
})

it('says when this month has not been billed yet', async () => {
  billing.listInvoices.mockResolvedValue([])
  show()

  expect(await screen.findByText('No invoices have been generated for this month yet.')).toBeInTheDocument()
})
