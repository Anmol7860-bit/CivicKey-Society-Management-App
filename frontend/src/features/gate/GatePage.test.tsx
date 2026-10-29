import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuthUser } from '../auth/api'
import * as api from './api'
import { GatePage } from './GatePage'

vi.mock('./api')
const mocked = vi.mocked(api)

const guard: AuthUser = {
  id: 'u1',
  name: 'Ramesh Kumar',
  phone: '9000000002',
  email: null,
  role: 'GUARD',
  societyId: 's1',
  permissions: ['VISIT_REGISTER', 'VISIT_DECIDE', 'VISIT_ENTRY_RECORD', 'VISIT_EXIT', 'PASS_VALIDATE'],
}

const pass = {
  id: 'p1',
  flatId: 'fl1',
  visitorName: 'Amit Kulkarni',
  visitorPhone: '9822222222',
  purpose: 'GUEST' as const,
  people: 2,
  validOn: '2026-10-22',
  validFrom: '18:00:00',
  validUntil: '21:00:00',
  vehicleNumber: null,
  passType: 'ONE_ENTRY' as const,
  note: 'Parcel can be left with security',
  entryCode: '482913',
  status: 'ACTIVE' as const,
  usedAt: null,
  createdAt: '2026-10-22T10:00:00.000Z',
  flat: { number: '101', blockName: 'A', floorLabel: '1st Floor', label: 'A-101' },
}

beforeEach(() => {
  vi.resetAllMocks()
  mocked.listInside.mockResolvedValue([])
  mocked.listVisits.mockResolvedValue([])
  mocked.listDeliveriesAtGate.mockResolvedValue([])
})

const show = () => render(<GatePage user={guard} accessToken="token" />)

it('shows what a valid pass is good for, and lets the visitor in', async () => {
  mocked.validatePass.mockResolvedValue({ valid: true, reason: null, pass })
  mocked.registerVisit.mockResolvedValue({ id: 'v1', visitorName: 'Amit Kulkarni' } as never)
  mocked.recordEntry.mockResolvedValue({ id: 'v1' } as never)
  show()

  await userEvent.type(screen.getByLabelText('Entry code'), '482913')
  await userEvent.click(screen.getAllByRole('button', { name: 'Check' })[0]!)

  expect(await screen.findByText('Valid pass · pre-approved by the resident')).toBeInTheDocument()
  expect(screen.getByText('Parcel can be left with security')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Allow and record entry' }))
  await waitFor(() => expect(mocked.recordEntry).toHaveBeenCalledWith('token', 'v1'))
  expect(await screen.findByText('Amit Kulkarni is in.')).toBeInTheDocument()
})

it('refuses a used pass with the reason and offers no way in', async () => {
  mocked.validatePass.mockResolvedValue({ valid: false, reason: 'This pass has already been used', pass: { ...pass, status: 'USED' } })
  show()

  await userEvent.type(screen.getByLabelText('Entry code'), '482913')
  await userEvent.click(screen.getAllByRole('button', { name: 'Check' })[0]!)

  expect(await screen.findByText('This pass has already been used')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Allow and record entry' })).not.toBeInTheDocument()
})

it('checks a staff pass and records the entry', async () => {
  mocked.checkStaffPass.mockResolvedValue({
    valid: true,
    reason: null,
    staff: {
      id: 'st1',
      name: 'Sunita Devi',
      kind: 'DAILY_HELP',
      workType: 'Maid',
      passValidUntil: '2027-03-31',
      inside: false,
      enteredAt: null,
      flatsServed: [{ flatId: 'fl1', number: '101', blockName: 'A', label: 'A-101', timeWindow: '7-9 am' }],
    } as never,
  })
  mocked.recordStaffEntry.mockResolvedValue({ id: 'a1', enteredAt: new Date().toISOString() })
  show()

  await userEvent.type(screen.getByLabelText('Staff pass number'), 'CK-SEEDHELP')
  await userEvent.click(screen.getAllByRole('button', { name: 'Check' })[1]!)

  expect(await screen.findByText('Sunita Devi')).toBeInTheDocument()
  expect(screen.getByText('Maid · A-101')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Record entry' }))
  // Every tap carries a request id, so a retry after a lost response cannot record a second entry
  await waitFor(() =>
    expect(mocked.recordStaffEntry).toHaveBeenCalledWith('token', 'st1', { idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) }),
  )
})

it('records a refused entry with its reason instead of letting the staff member in', async () => {
  mocked.checkStaffPass.mockResolvedValue({
    valid: true,
    reason: null,
    staff: { id: 'st1', name: 'Sunita Devi', kind: 'DAILY_HELP', workType: 'Maid', passValidUntil: null, inside: false, enteredAt: null, flatsServed: [] } as never,
  })
  mocked.rejectStaffEntry.mockResolvedValue({ id: 'r1' })
  show()

  await userEvent.type(screen.getByLabelText('Staff pass number'), 'CK-SEEDHELP')
  await userEvent.click(screen.getAllByRole('button', { name: 'Check' })[1]!)
  await userEvent.click(await screen.findByRole('button', { name: 'Reject' }))

  // A refusal of Other has to say what happened, so the button waits for a description
  await userEvent.selectOptions(screen.getByLabelText('Reason'), 'OTHER')
  expect(screen.getByRole('button', { name: 'Record refusal' })).toBeDisabled()
  await userEvent.type(screen.getByLabelText(/^What happened/), 'Could not match the photo')
  await userEvent.click(screen.getByRole('button', { name: 'Record refusal' }))

  await waitFor(() =>
    expect(mocked.rejectStaffEntry).toHaveBeenCalledWith('token', 'st1', {
      reason: 'OTHER',
      note: 'Could not match the photo',
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }),
  )
  expect(mocked.recordStaffEntry).not.toHaveBeenCalled()
  expect(await screen.findByText('Sunita Devi was refused. The reason is on the record.')).toBeInTheDocument()
})

it('records an exit from the inside list', async () => {
  mocked.listInside.mockResolvedValue([
    { id: 'v2', kind: 'VISITOR', name: 'Dev Courier', type: 'DELIVERY', flat: 'B-204', enteredAt: '2026-10-22T12:20:00.000Z', vehicleNumber: null, gateName: 'Main gate', overstayed: false },
  ])
  mocked.recordExit.mockResolvedValue({ id: 'v2' } as never)
  show()

  expect(await screen.findByRole('cell', { name: 'Dev Courier' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Record exit' }))

  await waitFor(() => expect(mocked.recordExit).toHaveBeenCalledWith('token', 'v2'))
  expect(await screen.findByText('Dev Courier is out.')).toBeInTheDocument()
})

it('turns an approved visitor away with a reason, and asks for one when it is Other', async () => {
  mocked.listVisits.mockResolvedValue([
    { id: 'v9', visitorName: 'Dev Courier', purpose: 'DELIVERY', flat: { label: 'A-101' } } as never,
  ])
  mocked.rejectVisitAtGate.mockResolvedValue({ id: 'v9' } as never)
  show()

  await userEvent.click(await screen.findByRole('button', { name: 'Turn away' }))
  // Other says nothing by itself, so the refusal waits for the explanation
  await userEvent.selectOptions(screen.getByLabelText('Reason'), 'OTHER')
  await userEvent.click(screen.getAllByRole('button', { name: 'Turn away' })[1]!)
  expect(mocked.rejectVisitAtGate).not.toHaveBeenCalled()

  await userEvent.selectOptions(screen.getByLabelText('Reason'), 'SECURITY_CONCERN')
  await userEvent.click(screen.getAllByRole('button', { name: 'Turn away' })[1]!)
  await waitFor(() => expect(mocked.rejectVisitAtGate).toHaveBeenCalledWith('token', 'v9', { reason: 'SECURITY_CONCERN' }))
  expect(await screen.findByText('Dev Courier was turned away at the gate.')).toBeInTheDocument()
})
