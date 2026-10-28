import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuthUser } from '../auth/api'
import * as files from '../file/api'
import * as api from './api'
import { VisitorRegistrationPage } from './VisitorRegistrationPage'

vi.mock('./api')
vi.mock('../file/api')
const mocked = vi.mocked(api)

const guard: AuthUser = {
  id: 'u1',
  name: 'Ramesh Kumar',
  phone: '9000000002',
  email: null,
  role: 'GUARD',
  societyId: 's1',
  permissions: ['VISIT_REGISTER', 'VISIT_ENTRY_RECORD', 'VISIT_EXIT', 'PASS_VALIDATE'],
}

beforeEach(() => {
  vi.resetAllMocks()
  mocked.flatDirectory.mockResolvedValue([{ id: 'fl1', label: 'A-101', residents: [{ id: 'r1', name: 'Riya Sharma' }] }])
  mocked.lookupVisitor.mockResolvedValue(null)
  vi.mocked(files).uploadImage.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' } as never)
})

const show = () => render(<VisitorRegistrationPage user={guard} accessToken="token" />)

/** The gate photograph: mandatory, so every registration test has to take one. */
const takePhoto = () =>
  userEvent.upload(screen.getByLabelText(/Visitor photo/), new File(['x'], 'visitor.png', { type: 'image/png' }))

it('registers a visitor against a flat and says the resident was asked', async () => {
  mocked.registerVisit.mockResolvedValue({ id: 'v1', visitorName: 'Dev Courier', status: 'AWAITING_APPROVAL' } as never)
  show()

  await userEvent.type(screen.getByLabelText(/Visitor mobile/), '9833333333')
  await userEvent.type(screen.getByLabelText(/Visitor name/), 'Dev Courier')
  await userEvent.click(screen.getByRole('button', { name: 'Delivery' }))
  await userEvent.selectOptions(await screen.findByLabelText(/Flat to visit/), 'fl1')
  await takePhoto()
  await userEvent.click(screen.getByRole('button', { name: 'Send for resident approval' }))

  await waitFor(() =>
    expect(mocked.registerVisit).toHaveBeenCalledWith(
      'token',
      's1',
      expect.objectContaining({
        flatId: 'fl1',
        visitorName: 'Dev Courier',
        purpose: 'DELIVERY',
        visitorPhone: '9833333333',
        photoReference: '11111111-1111-4111-8111-111111111111',
        expectedDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expectedTime: expect.stringMatching(/^\d{2}:\d{2}$/),
      }),
    ),
  )
  expect(await screen.findByText(/Dev Courier is waiting for the resident/)).toBeInTheDocument()
})

it('fills itself in for a visitor who has been before', async () => {
  mocked.lookupVisitor.mockResolvedValue({
    visitorName: 'Amit Kulkarni',
    visitorPhone: '9822222222',
    purpose: 'GUEST',
    company: null,
    vehicleNumber: 'MH 12 AB 3344',
    photoReference: null,
    lastVisit: { at: '2026-10-20T10:00:00.000Z', flat: 'A-101' },
  })
  show()

  await userEvent.type(screen.getByLabelText(/Visitor mobile/), '9822222222')
  await userEvent.tab()

  expect(await screen.findByDisplayValue('Amit Kulkarni')).toBeInTheDocument()
  expect(screen.getByDisplayValue('MH 12 AB 3344')).toBeInTheDocument()
  expect(screen.getByText('Came before · last visited A-101')).toBeInTheDocument()
})

it('takes an entry code and fills the form from the pass', async () => {
  mocked.validatePass.mockResolvedValue({
    valid: true,
    reason: null,
    pass: {
      id: 'p1',
      flatId: 'fl1',
      visitorName: 'Mahesh the plumber',
      visitorPhone: '9844444444',
      purpose: 'SERVICE',
      people: 1,
      vehicleNumber: null,
      note: 'Fixing the kitchen tap',
      entryCode: '482913',
      passType: 'ONE_ENTRY',
    } as never,
  })
  show()

  await userEvent.type(screen.getByLabelText('Entry code'), '482913')
  await userEvent.click(screen.getByRole('button', { name: 'Check' }))

  expect(await screen.findByDisplayValue('Mahesh the plumber')).toBeInTheDocument()
  expect(screen.getByDisplayValue('Fixing the kitchen tap')).toBeInTheDocument()
})

it('shows why a pass was refused instead of filling the form', async () => {
  mocked.validatePass.mockResolvedValue({ valid: false, reason: 'This pass expired', pass: null })
  show()

  await userEvent.type(screen.getByLabelText('Entry code'), '482913')
  await userEvent.click(screen.getByRole('button', { name: 'Check' }))

  expect(await screen.findByText('This pass expired')).toBeInTheDocument()
  expect(screen.getByLabelText(/Visitor name/)).toHaveValue('')
})

it('will not send a guest until the gate says who they asked for, and sends that resident', async () => {
  mocked.registerVisit.mockResolvedValue({ id: 'v2', visitorName: 'Asha Mehta', status: 'AWAITING_APPROVAL' } as never)
  show()

  await userEvent.type(screen.getByLabelText(/Visitor mobile/), '9855555555')
  await userEvent.type(screen.getByLabelText(/Visitor name/), 'Asha Mehta')
  await userEvent.selectOptions(await screen.findByLabelText(/Flat to visit/), 'fl1')
  await takePhoto()
  expect(screen.getByRole('button', { name: 'Send for resident approval' })).toBeDisabled()

  await userEvent.selectOptions(screen.getByLabelText(/Resident to visit/), 'r1')
  await userEvent.click(screen.getByRole('button', { name: 'Send for resident approval' }))

  await waitFor(() =>
    expect(mocked.registerVisit).toHaveBeenCalledWith('token', 's1', expect.objectContaining({ intendedResidentId: 'r1' })),
  )
})
