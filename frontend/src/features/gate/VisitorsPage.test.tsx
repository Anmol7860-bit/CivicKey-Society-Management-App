import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as societyApi from '../society/api'
import * as api from './api'
import { VisitorsPage } from './VisitorsPage'

vi.mock('./api')
vi.mock('../society/api', async () => ({
  ...(await vi.importActual<typeof societyApi>('../society/api')),
  listMyFlats: vi.fn(),
}))

const mocked = vi.mocked(api)
const society = vi.mocked(societyApi)

const assignment = {
  id: 'r1',
  flatId: 'fl1',
  accessLevel: 'FULL' as const,
  active: true,
  flat: { id: 'fl1', number: '101' },
  block: { id: 'b1', name: 'A' },
  floor: { id: 'f1', floorLabel: '1st Floor' },
  society: { id: 's1', name: 'Green Meadows' },
  household: [],
}

const waiting = {
  id: 'v1',
  visitorName: 'Amit Kulkarni',
  visitorPhone: '9822222222',
  purpose: 'GUEST' as const,
  company: null,
  people: 2,
  vehicleNumber: 'MH 12 AB 3344',
  status: 'AWAITING_APPROVAL' as const,
  createdAt: new Date().toISOString(),
  flat: { number: '101', blockName: 'A', floorLabel: '1st Floor', label: 'A-101' },
  gateName: 'Main gate',
  registeredByName: 'Mahesh Patil',
}

beforeEach(() => {
  vi.resetAllMocks()
  society.listMyFlats.mockResolvedValue([assignment as never])
  mocked.listMyVisits.mockResolvedValue([waiting as never])
  mocked.listMyPasses.mockResolvedValue([])
  mocked.listMyDeliveries.mockResolvedValue([])
})

it('shows who is at the gate and sends the approval', async () => {
  mocked.decideVisit.mockResolvedValue({ ...waiting, status: 'APPROVED' } as never)
  render(<VisitorsPage accessToken="token" />)

  expect(await screen.findByText('Waiting at the gate')).toBeInTheDocument()
  expect(screen.getByText('Amit Kulkarni')).toBeInTheDocument()
  expect(screen.getByText('Main gate · Mahesh Patil')).toBeInTheDocument()
  expect(screen.getByText('Photo taken by guard')).toBeInTheDocument()
  expect(screen.getByText('Resident · Flat A-101 / Visitors')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Approve entry' }))
  await waitFor(() => expect(mocked.decideVisit).toHaveBeenCalledWith('token', 'v1', { decision: 'APPROVED' }))
})

it('sends the reason with a denial', async () => {
  mocked.decideVisit.mockResolvedValue({ ...waiting, status: 'DENIED' } as never)
  render(<VisitorsPage accessToken="token" />)

  await userEvent.type(await screen.findByLabelText('Reason, if denying'), 'Not expecting anyone')
  await userEvent.click(screen.getByRole('button', { name: 'Deny' }))

  await waitFor(() =>
    expect(mocked.decideVisit).toHaveBeenCalledWith('token', 'v1', { decision: 'DENIED', reason: 'Not expecting anyone' }),
  )
})

it('creates a pass and shows the entry code to read out', async () => {
  mocked.createPass.mockResolvedValue({ id: 'p1', entryCode: '482913' } as never)
  render(<VisitorsPage accessToken="token" />)

  await userEvent.type(await screen.findByLabelText(/Visitor name/), 'Mahesh the plumber')
  await userEvent.type(screen.getByLabelText(/Visitor mobile/), '9844444444')
  await userEvent.click(screen.getByRole('button', { name: 'Create pass' }))

  await waitFor(() =>
    expect(mocked.createPass).toHaveBeenCalledWith(
      'token',
      'fl1',
      expect.objectContaining({ visitorName: 'Mahesh the plumber', visitorPhone: '9844444444', purpose: 'GUEST' }),
    ),
  )
  expect(await screen.findByText('Pass created. The entry code is 482913.')).toBeInTheDocument()
})

it('offers no pass form to a view-only member', async () => {
  society.listMyFlats.mockResolvedValue([{ ...assignment, accessLevel: 'VIEW_ONLY' } as never])
  render(<VisitorsPage accessToken="token" />)

  expect(await screen.findByText(/view-only access to this flat/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Create pass' })).not.toBeInTheDocument()
})

it('lists an issued pass with its code and cancels it', async () => {
  mocked.listMyPasses.mockResolvedValue([
    {
      id: 'p1',
      visitorName: 'Mahesh the plumber',
      entryCode: '482913',
      validOn: '2026-10-23',
      validFrom: '10:00:00',
      validUntil: '13:00:00',
      passType: 'ONE_ENTRY',
      status: 'ACTIVE',
    } as never,
  ])
  mocked.cancelPass.mockResolvedValue({ id: 'p1', status: 'CANCELLED' } as never)
  render(<VisitorsPage accessToken="token" />)

  const card = (await screen.findByText('482913')).closest('div')!
  await userEvent.click(within(card.parentElement!).getByRole('button', { name: 'Cancel pass' }))
  await waitFor(() => expect(mocked.cancelPass).toHaveBeenCalledWith('token', 'p1'))
})

it('shows the collection code for a parcel at the gate and acknowledges it', async () => {
  mocked.listMyDeliveries.mockResolvedValue([
    {
      id: 'd1',
      visitId: 'v1',
      visitorName: 'Dev Courier',
      purpose: 'DELIVERY',
      collectionCode: '482913',
      receivedAt: new Date().toISOString(),
      collectedAt: null,
      flat: { label: 'A-101' },
    } as never,
  ])
  mocked.collectDelivery.mockResolvedValue({ id: 'd1' } as never)
  render(<VisitorsPage accessToken="token" />)

  expect(await screen.findByText('482913')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Collected' }))
  await waitFor(() => expect(mocked.collectDelivery).toHaveBeenCalledWith('token', 'd1'))
})
