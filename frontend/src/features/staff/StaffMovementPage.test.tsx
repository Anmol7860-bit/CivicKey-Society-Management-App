import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuthUser } from '../auth/api'
import * as gateApi from '../gate/api'
import type { StaffMovement } from '../gate/api'
import { StaffMovementPage } from './StaffMovementPage'

vi.mock('../gate/api')
const gate = vi.mocked(gateApi)

const admin = { id: 'a1', name: 'Priya Desai', role: 'ADMIN', societyId: 's1', permissions: ['STAFF_MANAGE'] } as unknown as AuthUser

const entry: StaffMovement = {
  id: 'm1',
  staffId: 'st1',
  name: 'Ahmed Khan',
  staffType: 'Housekeeping',
  kind: 'DAILY_HELP',
  eventType: 'ENTRY',
  verificationStatus: 'VERIFIED',
  at: '2026-10-26T08:42:00+05:30',
  gateName: 'Main gate',
  performedBy: 'Mahesh Patil',
  rejectionReason: null,
  rejectionNote: null,
}

const refusal: StaffMovement = {
  ...entry,
  id: 'm2',
  eventType: 'ENTRY_REJECTED',
  verificationStatus: 'REJECTED',
  at: '2026-10-26T09:15:00+05:30',
  rejectionReason: 'SECURITY_CONCERN',
  rejectionNote: null,
}

beforeEach(() => {
  vi.resetAllMocks()
  gate.listStaffMovements.mockResolvedValue({ total: 2, movements: [refusal, entry] })
})

it('lists what the gate recorded, with who recorded it and why it was refused', async () => {
  render(<StaffMovementPage user={admin} accessToken="token" />)

  // 'Entry' and 'Entry refused' are also filter options, so the badges are read from the table
  const table = within(await screen.findByRole('table'))
  expect(table.getByText('Entry refused')).toBeInTheDocument()
  expect(table.getByText('Entry')).toBeInTheDocument()
  expect(screen.getAllByText('Ahmed Khan')).toHaveLength(2)
  expect(screen.getByText('Security concern')).toBeInTheDocument()
  expect(screen.getAllByText('Mahesh Patil')).toHaveLength(2)
  expect(gate.listStaffMovements).toHaveBeenCalledWith('token', 's1', { limit: 50 })
})

it('asks the server again when a filter changes', async () => {
  render(<StaffMovementPage user={admin} accessToken="token" />)
  await screen.findByText('Entry refused')

  await userEvent.selectOptions(screen.getByLabelText('Verification'), 'REJECTED')
  await waitFor(() => expect(gate.listStaffMovements).toHaveBeenLastCalledWith('token', 's1', { verificationStatus: 'REJECTED', limit: 50 }))

  await userEvent.type(screen.getByLabelText('Staff type'), 'Housekeeping')
  await waitFor(() =>
    expect(gate.listStaffMovements).toHaveBeenLastCalledWith('token', 's1', {
      verificationStatus: 'REJECTED',
      staffType: 'Housekeeping',
      limit: 50,
    }),
  )
})

it('asks for the next page only while more events are left', async () => {
  gate.listStaffMovements.mockResolvedValue({ total: 60, movements: Array.from({ length: 50 }, (_, index) => ({ ...entry, id: `m${index}` })) })
  render(<StaffMovementPage user={admin} accessToken="token" />)

  await userEvent.click(await screen.findByRole('button', { name: 'Show 10 more' }))
  await waitFor(() => expect(gate.listStaffMovements).toHaveBeenLastCalledWith('token', 's1', { limit: 100 }))
})

it('says so when nothing matches', async () => {
  gate.listStaffMovements.mockResolvedValue({ total: 0, movements: [] })
  render(<StaffMovementPage user={admin} accessToken="token" />)

  expect(await screen.findByRole('heading', { name: 'No staff movement recorded' })).toBeInTheDocument()
})
