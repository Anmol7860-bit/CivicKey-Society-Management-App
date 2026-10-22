import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from './api'
import { GatesTab } from './GatesTab'

vi.mock('./api')
const mocked = vi.mocked(api)

const gate = (overrides: Partial<api.Gate> = {}): api.Gate => ({
  id: 'g1',
  societyId: 's1',
  name: 'Main gate',
  usedFor: 'VISITORS_AND_RESIDENTS',
  status: 'ACTIVE',
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
  mocked.listGates.mockResolvedValue([gate()])
})

it('lists the gates with what each is used for', async () => {
  render(<GatesTab token="token" societyId="s1" />)

  expect(await screen.findByText('Main gate')).toBeInTheDocument()
  // The same label is an option in the select above, so the row's own text is matched by element
  expect(screen.getByText('Visitors and residents', { selector: 'span' })).toBeInTheDocument()
})

it('adds a gate with its purpose', async () => {
  mocked.createGate.mockResolvedValue(gate({ id: 'g2', name: 'Gate 2', usedFor: 'SERVICE_AND_DELIVERY' }))
  render(<GatesTab token="token" societyId="s1" />)

  await userEvent.type(await screen.findByLabelText(/Gate name/), 'Gate 2')
  await userEvent.selectOptions(screen.getByLabelText('Used for'), 'SERVICE_AND_DELIVERY')
  await userEvent.click(screen.getByRole('button', { name: 'Add gate' }))

  await waitFor(() =>
    expect(mocked.createGate).toHaveBeenCalledWith('token', 's1', { name: 'Gate 2', usedFor: 'SERVICE_AND_DELIVERY' }),
  )
  expect(await screen.findByText('Gate Gate 2 added.')).toBeInTheDocument()
})

it('renames a gate from its row', async () => {
  mocked.updateGate.mockResolvedValue(gate({ name: 'North gate' }))
  render(<GatesTab token="token" societyId="s1" />)

  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  const field = screen.getByLabelText(/Gate name/, { selector: '#gate-name-g1' })
  await userEvent.clear(field)
  await userEvent.type(field, 'North gate')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))

  await waitFor(() =>
    expect(mocked.updateGate).toHaveBeenCalledWith('token', 'g1', { name: 'North gate', usedFor: 'VISITORS_AND_RESIDENTS' }),
  )
})

it('collects a reason before closing a gate', async () => {
  mocked.updateGate.mockResolvedValue(gate({ status: 'INACTIVE' }))
  render(<GatesTab token="token" societyId="s1" />)

  await userEvent.click(await screen.findByRole('button', { name: 'Deactivate' }))
  await userEvent.type(screen.getByLabelText(/Reason/), 'Closed for works')
  await userEvent.click(screen.getByRole('dialog').querySelector('button[type="submit"]')!)

  await waitFor(() =>
    expect(mocked.updateGate).toHaveBeenCalledWith('token', 'g1', { status: 'INACTIVE', reason: 'Closed for works' }),
  )
})
