import { render, screen } from '@testing-library/react'
import type { MyAssignment } from './api'
import * as api from './api'
import { MyFlatPage } from './MyFlatPage'

vi.mock('./api')
const mocked = vi.mocked(api)

const assignment = (overrides: Partial<MyAssignment> = {}): MyAssignment => ({
  id: 'r1',
  flatId: 'fl1',
  userId: 'u1',
  residentType: 'TENANT',
  accessLevel: 'FULL',
  startDate: '2026-01-01',
  endDate: '2026-06-30',
  verificationStatus: 'VERIFIED',
  verifiedAt: '2026-01-02T00:00:00.000Z',
  rejectedReason: null,
  idDocumentType: 'AADHAAR',
  idDocumentLast4: '4321',
  proofReference: null,
  relationship: null,
  idDocumentOnFile: true,
  user: { id: 'u1', name: 'Arjun Nair', phone: '9876543216', email: null },
  active: true,
  eligible: true,
  flat: { id: 'fl1', number: '204', sharingAllowed: true, maxOccupants: 3 },
  floor: { id: 'f1', floorLabel: '2nd Floor' },
  block: { id: 'b1', name: 'B' },
  society: { id: 's1', name: 'Green Meadows' },
  household: [{ name: 'Riya Sharma', residentType: 'OWNER', accessLevel: 'FULL' }],
  ...overrides,
})

beforeEach(() => vi.resetAllMocks())

it('shows the approved assignment, the flat and the household', async () => {
  mocked.listMyFlats.mockResolvedValue([assignment()])
  render(<MyFlatPage accessToken="token" />)

  expect(await screen.findByRole('heading', { name: 'Block B · 2nd Floor · Flat 204' })).toBeInTheDocument()
  expect(screen.getByText('Green Meadows')).toBeInTheDocument()
  expect(screen.getByText('Riya Sharma')).toBeInTheDocument()
  // The last 4 are on file; the number itself never leaves the server
  expect(screen.getByText('Aadhaar ····4321')).toBeInTheDocument()
})

it('says access has ceased once the tenancy has ended, and hides the household', async () => {
  mocked.listMyFlats.mockResolvedValue([assignment({ active: false, eligible: false, household: [] })])
  render(<MyFlatPage accessToken="token" />)

  expect(await screen.findByText('Access ceased')).toBeInTheDocument()
  expect(screen.queryByText('Riya Sharma')).not.toBeInTheDocument()
})

it('tells a pending registration it is waiting, with no household', async () => {
  mocked.listMyFlats.mockResolvedValue([
    assignment({ verificationStatus: 'PENDING', active: false, eligible: false, household: [] }),
  ])
  render(<MyFlatPage accessToken="token" />)

  expect(await screen.findByText(/has not verified this registration yet/)).toBeInTheDocument()
  expect(screen.queryByText('Riya Sharma')).not.toBeInTheDocument()
})

it('explains view-only access instead of offering anything to manage', async () => {
  mocked.listMyFlats.mockResolvedValue([assignment({ accessLevel: 'VIEW_ONLY' })])
  render(<MyFlatPage accessToken="token" />)

  expect(await screen.findByText(/view-only access/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument()
})

it('says so when no flat has been assigned', async () => {
  mocked.listMyFlats.mockResolvedValue([])
  render(<MyFlatPage accessToken="token" />)

  expect(await screen.findByRole('heading', { name: 'No flat assigned yet' })).toBeInTheDocument()
})
