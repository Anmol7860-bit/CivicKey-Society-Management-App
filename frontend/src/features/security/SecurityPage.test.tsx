import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as societyApi from '../society/api'
import { aSociety } from '../society/fixtures'
import * as api from './api'
import { SecurityPage } from './SecurityPage'

vi.mock('./api')
vi.mock('../society/api', async () => ({
  ...(await vi.importActual<typeof societyApi>('../society/api')),
  listSocieties: vi.fn(),
}))

const mocked = vi.mocked(api)
const society = vi.mocked(societyApi)

beforeEach(() => {
  vi.resetAllMocks()
  society.listSocieties.mockResolvedValue([aSociety()])
  mocked.listAuditLogs.mockResolvedValue([
    {
      id: 'a1',
      eventType: 'AUTHORIZATION_DENIED',
      createdAt: '2026-02-05T09:30:00.000Z',
      metadata: { code: 'PERMISSION_DENIED', path: '/api/v1/societies/s1/billing-rates' },
      actor: { id: 'u2', name: 'Mahesh Patil', phone: '9811111111' },
    },
  ])
})

it('shows who did what, with the details behind the event', async () => {
  render(<SecurityPage accessToken="token" />)

  // 'Access denied' is also an option in the Event select, so the row is found by its actor
  expect(await screen.findByText('Mahesh Patil')).toBeInTheDocument()
  expect(screen.getByRole('cell', { name: 'Access denied' })).toBeInTheDocument()
  expect(screen.getByText(/PERMISSION_DENIED · \/api\/v1\/societies\/s1\/billing-rates/)).toBeInTheDocument()
})

it('filters by event and by user', async () => {
  render(<SecurityPage accessToken="token" />)
  await screen.findByText('Mahesh Patil')

  await userEvent.selectOptions(screen.getByLabelText('Event'), 'PAYMENT_RECORDED')
  await userEvent.type(screen.getByLabelText('User'), 'Anita')

  await waitFor(() =>
    expect(mocked.listAuditLogs).toHaveBeenLastCalledWith('token', 's1', { event: 'PAYMENT_RECORDED', user: 'Anita' }),
  )
})

it('says so when nothing has been recorded', async () => {
  mocked.listAuditLogs.mockResolvedValue([])
  render(<SecurityPage accessToken="token" />)

  expect(await screen.findByRole('heading', { name: 'Nothing recorded yet' })).toBeInTheDocument()
})
