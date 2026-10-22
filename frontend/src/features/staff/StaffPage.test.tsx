import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuthUser, Permission } from '../auth/api'
import * as societyApi from '../society/api'
import { aFlat, aSociety } from '../society/fixtures'
import * as api from './api'
import type { Staff } from './api'
import { StaffPage } from './StaffPage'

vi.mock('./api')
vi.mock('../society/api', async () => ({
  ...(await vi.importActual<typeof societyApi>('../society/api')),
  listSocieties: vi.fn(),
  listGates: vi.fn(),
  getOccupancy: vi.fn(),
}))

const mocked = vi.mocked(api)
const society = vi.mocked(societyApi)

const user = (permissions: Permission[]): AuthUser => ({
  id: 'u1',
  name: 'Anita Rao',
  role: 'ADMIN',
  permissions,
  societyId: 's1',
  phone: '9876543212',
  email: null,
})

const guard = (overrides: Partial<Staff> = {}): Staff => ({
  id: 'st1',
  societyId: 's1',
  kind: 'GUARD',
  name: 'Mahesh Patil',
  phone: '9811111111',
  workType: null,
  agency: 'SafeGuard',
  gateId: 'g1',
  gateName: 'Main gate',
  shift: 'MORNING',
  policeVerification: 'VERIFIED',
  gender: null,
  homeAddress: null,
  workingDays: 'MON,TUE',
  idDocumentType: null,
  idDocumentLast4: null,
  idDocumentOnFile: false,
  photoReference: null,
  passCode: 'CK-ABCD1234',
  passValidFrom: '2026-01-01',
  passValidUntil: null,
  status: 'ACTIVE',
  flatsServed: [],
  ...overrides,
})

function show(permissions: Permission[] = ['GUARD_MANAGE', 'STAFF_MANAGE']) {
  render(<StaffPage user={user(permissions)} accessToken="token" />)
}

beforeEach(() => {
  vi.resetAllMocks()
  society.listSocieties.mockResolvedValue([aSociety()])
  society.listGates.mockResolvedValue([
    { id: 'g1', societyId: 's1', name: 'Main gate', usedFor: 'VISITORS_AND_RESIDENTS', status: 'ACTIVE' },
  ])
  society.getOccupancy.mockResolvedValue({
    society: { id: 's1', name: 'Green Meadows' },
    summary: { flats: 1, inactive: 0, unsold: 1, owned: 0, vacant: 1, occupied: 0, sharingAvailable: 0 },
    blocks: [
      {
        id: 'b1',
        societyId: 's1',
        name: 'A',
        status: 'ACTIVE',
        floors: [{ id: 'f1', blockId: 'b1', floorLabel: '1st Floor', sortOrder: null, status: 'ACTIVE', flats: [aFlat()] }],
      },
    ],
  })
  mocked.listStaff.mockResolvedValue([guard()])
})

it('lists guards with their gate, shift, verification and pass code', async () => {
  show()

  expect(await screen.findByText('Mahesh Patil')).toBeInTheDocument()
  expect(screen.getByText('Main gate')).toBeInTheDocument()
  expect(screen.getByText('Verified')).toBeInTheDocument()
  expect(screen.getByText(/CK-ABCD1234/)).toBeInTheDocument()
})

it('shows only the tabs the Admin may manage', async () => {
  show(['STAFF_MANAGE'])

  await waitFor(() => expect(mocked.listStaff).toHaveBeenCalled())
  expect(screen.queryByRole('tab', { name: 'Guards' })).not.toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Daily help' })).toBeInTheDocument()
  expect(mocked.listStaff).toHaveBeenCalledWith('token', 's1', expect.objectContaining({ kind: 'DAILY_HELP' }))
})

it('filters the list by the search box and the shift', async () => {
  show()
  await screen.findByText('Mahesh Patil')

  await userEvent.type(screen.getByLabelText('Search'), 'mahesh')
  await userEvent.selectOptions(screen.getByLabelText(/^Shift/), 'NIGHT')

  await waitFor(() =>
    expect(mocked.listStaff).toHaveBeenLastCalledWith('token', 's1', { kind: 'GUARD', search: 'mahesh', shift: 'NIGHT' }),
  )
})

it('registers a guard with a gate and a shift, and will not submit without them', async () => {
  mocked.createStaff.mockResolvedValue(guard())
  show()

  await userEvent.click(await screen.findByRole('button', { name: /Add staff/ }))
  await userEvent.type(screen.getByLabelText(/Full name/), 'Ravi Kumar')
  await userEvent.type(screen.getByLabelText(/Mobile number/), '9823456789')
  await userEvent.click(screen.getByLabelText(/agreed to share their photo/))

  const submit = screen.getByRole('button', { name: 'Save and issue staff pass' })
  expect(submit).toBeDisabled()

  await userEvent.selectOptions(screen.getByLabelText(/^Gate/), 'g1')
  await userEvent.selectOptions(screen.getByLabelText(/^Shift \*/), 'NIGHT')
  expect(submit).toBeEnabled()
  await userEvent.click(submit)

  await waitFor(() =>
    expect(mocked.createStaff).toHaveBeenCalledWith(
      'token',
      's1',
      expect.objectContaining({ kind: 'GUARD', name: 'Ravi Kumar', phone: '9823456789', gateId: 'g1', shift: 'NIGHT' }),
    ),
  )
})

it('asks daily help for the flats it serves, and sends the time window with each', async () => {
  mocked.createStaff.mockResolvedValue(guard({ kind: 'DAILY_HELP' }))
  show()

  await userEvent.click(await screen.findByRole('tab', { name: 'Daily help' }))
  await userEvent.click(screen.getByRole('button', { name: /Add staff/ }))
  await userEvent.type(screen.getByLabelText(/Full name/), 'Sunita Devi')
  await userEvent.type(screen.getByLabelText(/Mobile number/), '9823456789')
  await userEvent.click(screen.getByLabelText(/agreed to share their photo/))

  expect(screen.getByRole('button', { name: 'Save and issue staff pass' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Add flat' }))
  await userEvent.selectOptions(screen.getByLabelText(/^Flat/), 'fl1')
  await userEvent.type(screen.getByLabelText('Expected'), '7-9 am')
  await userEvent.click(screen.getByRole('button', { name: 'Save and issue staff pass' }))

  await waitFor(() =>
    expect(mocked.createStaff).toHaveBeenCalledWith(
      'token',
      's1',
      expect.objectContaining({ kind: 'DAILY_HELP', flatsServed: [{ flatId: 'fl1', timeWindow: '7-9 am' }] }),
    ),
  )
})

it('reissues a pass from the row', async () => {
  mocked.reissuePass.mockResolvedValue(guard({ passCode: 'CK-NEW12345' }))
  show()

  await userEvent.click(await screen.findByRole('button', { name: 'Reissue pass' }))

  expect(mocked.reissuePass).toHaveBeenCalledWith('token', 'st1')
})

it('collects a reason before deactivating someone', async () => {
  mocked.updateStaff.mockResolvedValue(guard({ status: 'INACTIVE' }))
  show()

  await userEvent.click(await screen.findByRole('button', { name: 'Deactivate' }))
  await userEvent.type(screen.getByLabelText(/Reason/), 'Left the agency')
  await userEvent.click(screen.getByRole('dialog').querySelector('button[type="submit"]')!)

  await waitFor(() =>
    expect(mocked.updateStaff).toHaveBeenCalledWith('token', 'st1', { status: 'INACTIVE', reason: 'Left the agency' }),
  )
})

it('scrolls the form into view when Add staff is pressed', async () => {
  const scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView
  show()

  await userEvent.click(await screen.findByRole('button', { name: /Add staff/ }))

  await screen.findByLabelText(/Full name/)
  expect(scrollIntoView).toHaveBeenCalled()
})
