import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MyAssignment } from '../society/api'
import * as societyApi from '../society/api'
import * as gateApi from './api'
import type { DailyHelp } from './api'
import { DailyHelpPage } from './DailyHelpPage'

vi.mock('../society/api')
vi.mock('./api')
const society = vi.mocked(societyApi)
const gate = vi.mocked(gateApi)

const assignment = {
  id: 'r1',
  flatId: 'fl1',
  accessLevel: 'FULL',
  active: true,
} as MyAssignment

const help = (overrides: Partial<DailyHelp> = {}): DailyHelp => ({
  id: 'st1',
  societyId: 's1',
  kind: 'DAILY_HELP',
  name: 'Sunita Devi',
  phone: '9876543210',
  workType: 'Maid',
  agency: null,
  gateId: null,
  gateName: null,
  shift: null,
  policeVerification: 'VERIFIED',
  gender: 'FEMALE',
  homeAddress: null,
  workingDays: 'MON,TUE',
  idDocumentType: 'AADHAAR',
  idDocumentLast4: '7788',
  idDocumentOnFile: true,
  photoReference: 'office/photos/sunita.jpg',
  passCode: 'SP-4412',
  passValidFrom: '2026-01-01',
  passValidUntil: null,
  status: 'ACTIVE',
  timeWindow: '7-9 am',
  inside: false,
  enteredAt: null,
  onLeaveToday: false,
  lastSeen: null,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
  society.listMyFlats.mockResolvedValue([assignment])
  gate.listMyDailyHelp.mockResolvedValue([help()])
  gate.listMyAccessRequests.mockResolvedValue([])
})

it('shows each helper with the identity and verification the office holds', async () => {
  render(<DailyHelpPage accessToken="token" />)

  expect(await screen.findByText('Sunita Devi')).toBeInTheDocument()
  expect(screen.getByText('Police: Verified')).toBeInTheDocument()
  expect(screen.getByText('Aadhaar ····7788')).toBeInTheDocument()
  expect(screen.getByText('Photo on file')).toBeInTheDocument()
})

it('says when no ID or photo has been filed yet', async () => {
  gate.listMyDailyHelp.mockResolvedValue([
    help({ policeVerification: 'NOT_STARTED', idDocumentOnFile: false, idDocumentType: null, photoReference: null }),
  ])
  render(<DailyHelpPage accessToken="token" />)

  expect(await screen.findByText('No ID on file')).toBeInTheDocument()
  expect(screen.getByText('No photo on file')).toBeInTheDocument()
  expect(screen.getByText('Police: Not started')).toBeInTheDocument()
})

it('sends the new helper to the office as a daily help request, with no kind to choose', async () => {
  render(<DailyHelpPage accessToken="token" />)

  expect(await screen.findByRole('heading', { name: 'Add daily help' })).toBeInTheDocument()
  // The kind switch belongs to My flat's household panel; this screen is daily help only
  expect(screen.queryByRole('button', { name: 'Access for a family member' })).not.toBeInTheDocument()

  await userEvent.type(screen.getByLabelText(/^Name/), 'Ramesh Kumar')
  await userEvent.type(screen.getByLabelText(/^Mobile/), '9811122233')
  await userEvent.type(screen.getByLabelText('Work type'), 'Driver')
  await userEvent.click(screen.getByRole('button', { name: 'Send request' }))

  expect(gate.createAccessRequest).toHaveBeenCalledWith('token', {
    flatId: 'fl1',
    kind: 'DAILY_HELP',
    name: 'Ramesh Kumar',
    phone: '9811122233',
    relationship: 'Driver',
  })
})

it('keeps a view-only member from asking for new help', async () => {
  society.listMyFlats.mockResolvedValue([{ ...assignment, accessLevel: 'VIEW_ONLY' } as MyAssignment])
  render(<DailyHelpPage accessToken="token" />)

  expect(await screen.findByText(/view-only access to this flat, so you cannot send a request/)).toBeInTheDocument()
})
