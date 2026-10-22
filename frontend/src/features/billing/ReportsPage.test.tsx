import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as societyApi from '../society/api'
import { aSociety } from '../society/fixtures'
import * as api from './api'
import { ReportsPage } from './ReportsPage'

vi.mock('./api')
vi.mock('../society/api', async () => ({
  ...(await vi.importActual<typeof societyApi>('../society/api')),
  listSocieties: vi.fn(),
}))

const mocked = vi.mocked(api)
const society = vi.mocked(societyApi)

const collections = {
  report: 'COLLECTIONS' as const,
  columns: ['flat', 'period', 'billed', 'paid', 'outstanding', 'dueDate', 'status'],
  rows: [
    { flat: 'A-101', period: '2026-02-01', billed: 4600, paid: 600, outstanding: 4000, dueDate: '2026-02-10', status: 'PARTIALLY_PAID' },
  ],
  totals: { billed: 4600, paid: 600, outstanding: 4000 },
}

beforeEach(() => {
  vi.resetAllMocks()
  society.listSocieties.mockResolvedValue([aSociety()])
})

it('runs the chosen report and shows its totals and rows', async () => {
  mocked.runReport.mockResolvedValue(collections)
  render(<ReportsPage accessToken="token" />)

  await userEvent.click(await screen.findByRole('button', { name: 'View report' }))

  expect(await screen.findByText('A-101')).toBeInTheDocument()
  expect(screen.getByText('Part paid')).toBeInTheDocument()
  // The outstanding total, formatted as rupees
  expect(screen.getAllByText('₹4,000.00').length).toBeGreaterThan(0)
  expect(mocked.runReport).toHaveBeenCalledWith('token', 's1', expect.objectContaining({ report: 'COLLECTIONS' }))
})

it('drops the period for occupancy, which is a snapshot of today', async () => {
  mocked.runReport.mockResolvedValue({
    report: 'OCCUPANCY',
    columns: ['flat', 'occupancy'],
    rows: [{ flat: 'A-101', occupancy: 'VACANT' }],
    totals: { flats: 1, vacant: 1, rented: 0 },
  })
  render(<ReportsPage accessToken="token" />)

  await userEvent.selectOptions(await screen.findByLabelText('Report'), 'OCCUPANCY')
  expect(screen.queryByLabelText('Period')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'View report' }))

  await waitFor(() => expect(mocked.runReport).toHaveBeenCalledWith('token', 's1', { report: 'OCCUPANCY' }))
  expect((await screen.findAllByText('Vacant')).length).toBeGreaterThan(0)
})

it('downloads the same report as CSV', async () => {
  mocked.downloadReport.mockResolvedValue(undefined)
  render(<ReportsPage accessToken="token" />)

  await userEvent.click(await screen.findByRole('button', { name: 'Download CSV' }))

  await waitFor(() =>
    expect(mocked.downloadReport).toHaveBeenCalledWith('token', 's1', expect.objectContaining({ report: 'COLLECTIONS' })),
  )
})

it('says so when the report has no rows', async () => {
  mocked.runReport.mockResolvedValue({ report: 'COLLECTIONS', columns: ['flat'], rows: [], totals: {} })
  render(<ReportsPage accessToken="token" />)

  await userEvent.click(await screen.findByRole('button', { name: 'View report' }))

  expect(await screen.findByRole('heading', { name: 'Nothing to report' })).toBeInTheDocument()
})
