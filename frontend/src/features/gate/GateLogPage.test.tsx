import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AuthUser } from '../auth/api'
import * as api from './api'
import type { GateLog } from './api'
import { GateLogPage } from './GateLogPage'

vi.mock('./api')
const mocked = vi.mocked(api)

const guard = { id: 'g1', name: 'Mahesh Patil', role: 'GUARD', societyId: 's1', permissions: [] } as unknown as AuthUser

const at = (time: string) => `2026-10-26T${time}+05:30`

const log = (overrides: Partial<GateLog> = {}): GateLog => ({
  on: '2026-10-26',
  metrics: {
    entries: 3,
    exits: 1,
    stillInside: 2,
    openOvernight: 1,
    turnedAway: 1,
    averageStayMinutes: 42,
    busiestHour: { hour: 9, entries: 2 },
    byType: { DELIVERY: 2, STAFF: 1 },
  },
  movements: [
    {
      id: 'v1',
      kind: 'VISITOR',
      direction: 'OUT',
      at: at('11:20:00'),
      name: 'Dev Courier',
      type: 'DELIVERY',
      flat: 'A-101',
      gateName: 'Main gate',
      vehicleNumber: 'MH 12 AB 3344',
    },
    {
      id: 'st1',
      kind: 'STAFF',
      direction: 'IN',
      at: at('07:05:00'),
      name: 'Sunita Devi',
      type: 'DAILY_HELP',
      flat: 'A-101',
      gateName: 'Main gate',
      vehicleNumber: null,
    },
  ],
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
  mocked.getGateLog.mockResolvedValue(log())
})

it('shows the shift numbers and the movements behind them', async () => {
  render(<GateLogPage user={guard} accessToken="token" />)

  expect(await screen.findByRole('heading', { name: 'Gate log' })).toBeInTheDocument()
  expect(screen.getByText('Recorded in').nextSibling).toHaveTextContent('3')
  expect(screen.getByText('Recorded out').nextSibling).toHaveTextContent('1')
  expect(screen.getByText('42 min')).toBeInTheDocument()
  expect(screen.getByText('9:00–10:00')).toBeInTheDocument()
  // The handover question: who came in before today and was never recorded out
  expect(screen.getByText('1 came in before today')).toBeInTheDocument()

  expect(screen.getByText('Dev Courier')).toBeInTheDocument()
  expect(screen.getByText('MH 12 AB 3344')).toBeInTheDocument()
  expect(screen.getByText('Sunita Devi')).toBeInTheDocument()
  expect(screen.getAllByText('Out')).toHaveLength(1)
})

it('asks the server for another day when the date changes', async () => {
  render(<GateLogPage user={guard} accessToken="token" />)

  await screen.findByRole('heading', { name: 'Gate log' })
  const today = new Date()
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  expect(mocked.getGateLog).toHaveBeenCalledWith('token', 's1', iso)

  // A native date input takes a whole value at once, which is what the picker gives it
  fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-10-20' } })
  await waitFor(() => expect(mocked.getGateLog).toHaveBeenLastCalledWith('token', 's1', '2026-10-20'))
})

it('says so when nothing was recorded', async () => {
  mocked.getGateLog.mockResolvedValue(
    log({
      metrics: { entries: 0, exits: 0, stillInside: 0, openOvernight: 0, turnedAway: 0, averageStayMinutes: null, busiestHour: null, byType: {} },
      movements: [],
    }),
  )
  render(<GateLogPage user={guard} accessToken="token" />)

  expect(await screen.findByRole('heading', { name: 'Nothing was recorded' })).toBeInTheDocument()
  expect(screen.getByText('Everyone who came in is out')).toBeInTheDocument()
  expect(screen.queryByText('What came through')).not.toBeInTheDocument()
})
