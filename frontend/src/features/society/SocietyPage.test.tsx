import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError, type AuthUser, type Permission } from '../auth/api'
import * as api from './api'
import { SocietyPage } from './SocietyPage'

vi.mock('./api')
const mocked = vi.mocked(api)

const SOCIETY = { id: 's1', name: 'Green Meadows', address: null }
const BLOCK_A = { id: 'b1', societyId: 's1', name: 'A', status: 'ACTIVE' as const }
const BLOCK_B = { id: 'b2', societyId: 's1', name: 'B', status: 'ACTIVE' as const }
const FLOOR_A1 = { id: 'f1', blockId: 'b1', floorLabel: '1st Floor', sortOrder: null, status: 'ACTIVE' as const }
const FLOOR_B2 = { id: 'f2', blockId: 'b2', floorLabel: 'Terrace', sortOrder: null, status: 'ACTIVE' as const }

const admin = (permissions: Permission[] = ['SOCIETY_MANAGE', 'USER_MANAGE']): AuthUser => ({
  id: 'u1',
  name: 'Anita Rao',
  phone: null,
  email: null,
  role: 'ADMIN',
  societyId: 's1',
  permissions,
})

const validationError = (field: string, message: string) =>
  new ApiError('VALIDATION_ERROR', 'Request validation failed', undefined, [{ field, message }])

function show(user = admin()) {
  render(<SocietyPage user={user} accessToken="token" />)
}

const openTab = async (name: string) => userEvent.click(await screen.findByRole('tab', { name }))

beforeEach(() => {
  vi.resetAllMocks()
  mocked.listSocieties.mockResolvedValue([SOCIETY])
  mocked.listBlocks.mockResolvedValue([BLOCK_A, BLOCK_B])
  mocked.listFloors.mockImplementation(async (_token, blockId) => (blockId === 'b1' ? [FLOOR_A1] : [FLOOR_B2]))
  mocked.listFlats.mockResolvedValue([])
  mocked.listResidents.mockResolvedValue([])
  mocked.getOccupancy.mockResolvedValue({
    society: { id: 's1', name: 'Green Meadows' },
    summary: { flats: 0, inactive: 0, unsold: 0, owned: 0, vacant: 0, occupied: 0, sharingAvailable: 0 },
    blocks: [],
  })
})

describe('society structure', () => {
  it('shows the society and its empty hierarchy', async () => {
    show()

    expect(await screen.findByDisplayValue('Green Meadows')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'No blocks yet' })).toBeInTheDocument()
  })

  it('reports a failed load and retries it', async () => {
    mocked.getOccupancy.mockRejectedValueOnce(new ApiError('INTERNAL_ERROR', 'Something went wrong'))
    show()

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(mocked.getOccupancy).toHaveBeenCalledTimes(2))
  })

  it('hides the resident tabs from an Admin without USER_MANAGE', async () => {
    show(admin(['SOCIETY_MANAGE']))

    await screen.findByRole('tab', { name: 'Structure' })
    expect(screen.queryByRole('tab', { name: 'Residents' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Approvals' })).not.toBeInTheDocument()
  })
})

describe('block management', () => {
  it('creates a block and shows it once the list reloads', async () => {
    mocked.createBlock.mockResolvedValue({ ...BLOCK_A, id: 'b3', name: 'C' })
    show()
    await openTab('Blocks')

    await userEvent.type(await screen.findByLabelText(/Block name/), 'C')
    await userEvent.click(screen.getByRole('button', { name: 'Add block' }))

    await waitFor(() => expect(mocked.createBlock).toHaveBeenCalledWith('token', 's1', { name: 'C' }))
    expect(await screen.findByText('Block C created.')).toBeInTheDocument()
  })

  it('keeps a duplicate-name error beside the field', async () => {
    mocked.createBlock.mockRejectedValue(validationError('name', 'A block with this name already exists'))
    show()
    await openTab('Blocks')

    await userEvent.type(await screen.findByLabelText(/Block name/), 'A')
    await userEvent.click(screen.getByRole('button', { name: 'Add block' }))

    expect(await screen.findByText('A block with this name already exists')).toBeInTheDocument()
    expect(screen.getByLabelText(/Block name/)).toHaveAttribute('aria-invalid', 'true')
  })

  it('will not submit an empty name', async () => {
    show()
    await openTab('Blocks')

    expect(await screen.findByRole('button', { name: 'Add block' })).toBeDisabled()
    expect(mocked.createBlock).not.toHaveBeenCalled()
  })

  it('asks for a reason before deactivating, and sends it', async () => {
    mocked.updateBlock.mockResolvedValue({ ...BLOCK_A, status: 'INACTIVE' })
    show()
    await openTab('Blocks')

    const rows = await screen.findAllByRole('button', { name: 'Deactivate' })
    await userEvent.click(rows[0]!)

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Deactivate' })).toBeDisabled()

    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Demolished')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }))

    await waitFor(() =>
      expect(mocked.updateBlock).toHaveBeenCalledWith('token', 'b1', { status: 'INACTIVE', reason: 'Demolished' }),
    )
  })
})

describe('floor management', () => {
  it('lists only the floors of the chosen block', async () => {
    show()
    await openTab('Floors')

    expect(await screen.findByRole('heading', { name: 'Choose a block' })).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText(/Block/), 'b2')
    expect(await screen.findByText('Terrace')).toBeInTheDocument()
    expect(screen.queryByText('1st Floor')).not.toBeInTheDocument()
  })

  it('keeps a free-text label and an optional order', async () => {
    mocked.createFloor.mockResolvedValue(FLOOR_A1)
    show()
    await openTab('Floors')

    await userEvent.selectOptions(screen.getByLabelText(/Block/), 'b1')
    await userEvent.type(screen.getByLabelText(/Floor label/), 'B2')
    await userEvent.click(screen.getByRole('button', { name: 'Add floor' }))

    await waitFor(() => expect(mocked.createFloor).toHaveBeenCalledWith('token', 'b1', { floorLabel: 'B2', sortOrder: null }))
  })
})

describe('flat management', () => {
  it('needs a block and one of its floors before a flat can be added', async () => {
    show()
    await openTab('Flats')

    const addFlat = await screen.findByRole('button', { name: 'Add flat' })
    expect(addFlat).toBeDisabled()
    expect(screen.getByLabelText(/Floor/)).toBeDisabled()

    await userEvent.selectOptions(screen.getByLabelText(/Block/), 'b1')
    await waitFor(() => expect(screen.getByLabelText(/Floor/)).toBeEnabled())

    // Only the chosen block's floor is offered
    expect(within(screen.getByLabelText(/Floor/)).getByRole('option', { name: '1st Floor' })).toBeInTheDocument()
    expect(within(screen.getByLabelText(/Floor/)).queryByRole('option', { name: 'Terrace' })).not.toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText(/Floor/), 'f1')
    await userEvent.type(screen.getByLabelText(/Flat number/), '101')
    expect(screen.getByRole('button', { name: 'Add flat' })).toBeEnabled()
  })

  it('drops the floor choice when the block changes', async () => {
    show()
    await openTab('Flats')

    await userEvent.selectOptions(await screen.findByLabelText(/Block/), 'b1')
    await waitFor(() => expect(screen.getByLabelText(/Floor/)).toBeEnabled())
    await userEvent.selectOptions(screen.getByLabelText(/Floor/), 'f1')

    await userEvent.selectOptions(screen.getByLabelText(/Block/), 'b2')

    await waitFor(() => expect(screen.getByLabelText(/Floor/)).toHaveValue(''))
    expect(screen.getByRole('button', { name: 'Add flat' })).toBeDisabled()
  })
})

describe('registration review', () => {
  const pending = {
    id: 'r1',
    flatId: 'fl1',
    userId: 'u9',
    residentType: 'TENANT' as const,
    accessLevel: 'FULL' as const,
    startDate: '2026-01-01',
    endDate: '2027-01-01',
    verificationStatus: 'PENDING' as const,
    verifiedAt: null,
    rejectedReason: null,
    idDocumentType: null,
    idDocumentLast4: null,
    proofReference: null,
    idDocumentOnFile: false,
    user: { id: 'u9', name: 'Arjun Nair', phone: '9876543216', email: null },
    active: false,
    eligible: false,
    flat: { id: 'fl1', number: '204' },
    block: { id: 'b2', name: 'B' },
  }

  it('opens the approval queue filtered to what is waiting', async () => {
    mocked.listResidents.mockResolvedValue([pending])
    show()
    await openTab('Approvals')

    expect(await screen.findByText('Arjun Nair')).toBeInTheDocument()
    expect(mocked.listResidents).toHaveBeenCalledWith('token', 's1', expect.objectContaining({ status: 'PENDING' }))
  })

  it('verifies with the access level the Admin chose', async () => {
    mocked.listResidents.mockResolvedValue([pending])
    mocked.verifyResident.mockResolvedValue({ ...pending, verificationStatus: 'VERIFIED' })
    show()
    await openTab('Approvals')

    await userEvent.selectOptions(await screen.findByLabelText('Flat access'), 'VIEW_ONLY')
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))

    await waitFor(() => expect(mocked.verifyResident).toHaveBeenCalledWith('token', 'r1', { accessLevel: 'VIEW_ONLY' }))
  })

  it('takes a reason when rejecting', async () => {
    mocked.listResidents.mockResolvedValue([pending])
    mocked.rejectResident.mockResolvedValue({ ...pending, verificationStatus: 'REJECTED' })
    show()
    await openTab('Approvals')

    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Lease not provided')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject' }))

    await waitFor(() => expect(mocked.rejectResident).toHaveBeenCalledWith('token', 'r1', { reason: 'Lease not provided' }))
  })
})
