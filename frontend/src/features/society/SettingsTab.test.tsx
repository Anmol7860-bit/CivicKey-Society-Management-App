import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from './api'
import { SettingsTab } from './SettingsTab'

vi.mock('./api')
const mocked = vi.mocked(api)

const job = (overrides: Partial<api.BackupJob> = {}): api.BackupJob => ({
  id: 'b1',
  status: 'READY',
  byteSize: 2_097_152,
  errorCode: null,
  createdAt: '2026-10-26T09:00:00.000Z',
  completedAt: '2026-10-26T09:00:30.000Z',
  expiresAt: '2026-10-26T09:15:00.000Z',
  downloadedAt: null,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
  mocked.getSettings.mockResolvedValue({ societyId: 's1', timezone: 'Asia/Kolkata', idRequired: false })
  mocked.listBackups.mockResolvedValue([])
})

const show = () => render(<SettingsTab token="token" societyId="s1" />)

it('turns the government-ID requirement on for the whole society', async () => {
  mocked.updateSettings.mockResolvedValue({ societyId: 's1', timezone: 'Asia/Kolkata', idRequired: true })
  show()

  await userEvent.click(await screen.findByLabelText(/Require a government ID/))

  await waitFor(() => expect(mocked.updateSettings).toHaveBeenCalledWith('token', 's1', { idRequired: true }))
  expect(await screen.findByText('Saved.')).toBeInTheDocument()
})

it('asks for a backup and shows what became of it', async () => {
  mocked.requestBackup.mockResolvedValue(job({ status: 'PENDING', byteSize: null, expiresAt: null, completedAt: null }))
  mocked.listBackups.mockResolvedValueOnce([]).mockResolvedValue([job()])
  show()

  await userEvent.click(await screen.findByRole('button', { name: 'Export a backup' }))

  expect(mocked.requestBackup).toHaveBeenCalledWith('token', 's1')
  expect(await screen.findByText('Ready')).toBeInTheDocument()
  expect(screen.getByText('2.0 MB')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Download' }))
  expect(mocked.downloadBackup).toHaveBeenCalledWith('token', 'b1')
})

it('says why a backup failed rather than hiding it', async () => {
  mocked.listBackups.mockResolvedValue([job({ status: 'FAILED', byteSize: null, errorCode: 'PG_DUMP_MISSING' })])
  show()

  expect(await screen.findByText('Failed')).toBeInTheDocument()
  expect(screen.getByText('PG_DUMP_MISSING')).toBeInTheDocument()
})
