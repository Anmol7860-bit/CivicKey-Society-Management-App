import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuthUser } from '../auth/api'
import * as gateApi from './api'
import type { VisitMovement } from './api'
import { VisitorMovementPage } from './VisitorMovementPage'

vi.mock('./api')
const gate = vi.mocked(gateApi)

const admin = { id: 'a1', name: 'Priya Desai', role: 'ADMIN', societyId: 's1', permissions: ['STAFF_MANAGE'] } as unknown as AuthUser

const entry: VisitMovement = {
  visitId: 'v1',
  eventType: 'ENTRY',
  at: '2026-10-26T08:42:00+05:30',
  name: 'Amit Kulkarni',
  phone: '9822222222',
  purpose: 'GUEST',
  flat: 'A-101',
  gateName: 'Main gate',
  performedBy: 'Mahesh Patil',
  rejectionReason: null,
  rejectionNote: null,
}

const refusal: VisitMovement = {
  ...entry,
  visitId: 'v2',
  eventType: 'ENTRY_REJECTED',
  at: '2026-10-26T09:15:00+05:30',
  rejectionReason: 'SECURITY_CONCERN',
}

beforeEach(() => {
  vi.resetAllMocks()
  gate.listVisitorMovements.mockResolvedValue({ total: 2, movements: [refusal, entry] })
})

it('lists what the gate recorded, with the guard behind each event and why one was refused', async () => {
  render(<VisitorMovementPage user={admin} accessToken="token" />)

  // 'Entry' and 'Turned away' are filter options too, so the badges are read from the table
  const table = within(await screen.findByRole('table'))
  expect(table.getByText('Entry')).toBeInTheDocument()
  expect(table.getByText('Turned away')).toBeInTheDocument()
  expect(screen.getAllByText('Amit Kulkarni')).toHaveLength(2)
  expect(screen.getByText('Security concern')).toBeInTheDocument()
  expect(screen.getAllByText('Mahesh Patil')).toHaveLength(2)
  expect(gate.listVisitorMovements).toHaveBeenCalledWith('token', 's1', { limit: 50 })
})

it('asks the server again when a filter changes', async () => {
  render(<VisitorMovementPage user={admin} accessToken="token" />)
  await screen.findByRole('table')

  await userEvent.selectOptions(screen.getByLabelText('Where they are'), 'INSIDE')
  await waitFor(() => expect(gate.listVisitorMovements).toHaveBeenLastCalledWith('token', 's1', { movementState: 'INSIDE', limit: 50 }))

  await userEvent.type(screen.getByLabelText('Visitor'), 'Amit')
  await waitFor(() =>
    expect(gate.listVisitorMovements).toHaveBeenLastCalledWith('token', 's1', { movementState: 'INSIDE', search: 'Amit', limit: 50 }),
  )
})

it('asks for the next page only while more events are left', async () => {
  gate.listVisitorMovements.mockResolvedValue({
    total: 60,
    movements: Array.from({ length: 50 }, (_, index) => ({ ...entry, visitId: `v${index}` })),
  })
  render(<VisitorMovementPage user={admin} accessToken="token" />)

  await userEvent.click(await screen.findByRole('button', { name: 'Show 10 more' }))
  await waitFor(() => expect(gate.listVisitorMovements).toHaveBeenLastCalledWith('token', 's1', { limit: 100 }))
})

it('says so when nothing matches', async () => {
  gate.listVisitorMovements.mockResolvedValue({ total: 0, movements: [] })
  render(<VisitorMovementPage user={admin} accessToken="token" />)

  expect(await screen.findByRole('heading', { name: 'No visitor movement recorded' })).toBeInTheDocument()
})
