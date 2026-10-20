import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IDBFactory } from 'fake-indexeddb'
import { MemoryRouter } from 'react-router'
import { AreaRoute } from '../shell/AreaRoute'
import { closeDbForTests } from './db'
import { enqueue } from './queue'

const guard = {
  id: 'g1',
  name: 'Mahesh Patil',
  phone: null,
  email: null,
  role: 'GUARD' as const,
  societyId: null,
  permissions: ['VISIT_REGISTER' as const],
}

beforeEach(() => {
  closeDbForTests()
  globalThis.indexedDB = new IDBFactory()
})

afterEach(() => vi.unstubAllGlobals())

it('shows entries waiting to sync and uploads them when the guard presses Sync now', async () => {
  // Backend down while the entry is recorded and when the page opens
  const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
  vi.stubGlobal('fetch', fetchMock)
  await enqueue('VISITOR_REGISTER', { name: 'Ravi', flat: 'A-101' })

  render(
    <MemoryRouter initialEntries={['/guard/sync']}>
      <AreaRoute user={guard} accessToken="token" onLogout={async () => {}} />
    </MemoryRouter>,
  )

  expect(await screen.findByRole('heading', { name: 'Sync status' })).toBeInTheDocument()
  const table = await screen.findByRole('table')
  expect(await within(table).findByText('Will retry')).toBeInTheDocument()
  expect(within(table).getByText('NETWORK_ERROR')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('1 entry waiting to sync')
  expect(screen.getByRole('link', { name: /1 entry waiting to sync/ })).toHaveAttribute('href', '/guard/sync')

  fetchMock.mockResolvedValue(new Response('{}', { status: 201 }))
  await userEvent.click(screen.getByRole('button', { name: 'Sync now' }))

  expect(await within(table).findByText('Synced')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('All entries synced')
})
