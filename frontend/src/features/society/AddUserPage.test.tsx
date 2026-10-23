import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { ApiError } from '../auth/api'
import { AddUserPage } from './AddUserPage'
import * as api from './api'
import { aFlat, aSociety } from './fixtures'

vi.mock('./api')
const mocked = vi.mocked(api)

const flat = aFlat()

function show(path = '/admin/add-user') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AddUserPage accessToken="token" />
    </MemoryRouter>,
  )
}

/** Fills everything the API insists on, leaving the optional profile fields alone. */
async function fillRequired() {
  await userEvent.type(await screen.findByLabelText(/Full name/), 'Arjun Nair')
  await userEvent.type(screen.getByLabelText(/Mobile number/), '9876543216')
  await userEvent.selectOptions(screen.getByLabelText(/^Block/), 'b1')
  await waitFor(() => expect(screen.getByLabelText(/^Flat \*/)).toBeEnabled())
  await userEvent.selectOptions(screen.getByLabelText(/^Flat \*/), 'fl1')
  await userEvent.click(screen.getByRole('checkbox'))
}

beforeEach(() => {
  vi.resetAllMocks()
  mocked.listSocieties.mockResolvedValue([aSociety()])
  mocked.getOccupancy.mockResolvedValue({
    society: { id: 's1', name: 'Green Meadows' },
    summary: { flats: 1, inactive: 0, unsold: 1, owned: 0, vacant: 1, occupied: 0, sharingAvailable: 0 },
    blocks: [
      {
        id: 'b1',
        societyId: 's1',
        name: 'A',
        status: 'ACTIVE',
        floors: [{ id: 'f1', blockId: 'b1', floorLabel: '1st Floor', sortOrder: null, status: 'ACTIVE', flats: [flat] }],
      },
    ],
  })
})

it('offers the three roles and says where Guard accounts will live', async () => {
  show()

  expect(await screen.findByRole('radio', { name: /Resident/ })).toHaveAttribute('aria-checked', 'true')
  await userEvent.click(screen.getByRole('radio', { name: /Guard/ }))

  expect(screen.getByText(/Guards are added under Staff management/)).toBeInTheDocument()
  expect(screen.queryByLabelText(/Full name/)).not.toBeInTheDocument()
})

it('keeps the submit disabled until the required fields and the consent are there', async () => {
  show()

  const submit = await screen.findByRole('button', { name: 'Register resident' })
  expect(submit).toBeDisabled()

  await userEvent.type(screen.getByLabelText(/Full name/), 'Arjun Nair')
  await userEvent.type(screen.getByLabelText(/Mobile number/), '9876543216')
  await userEvent.selectOptions(screen.getByLabelText(/^Block/), 'b1')
  await waitFor(() => expect(screen.getByLabelText(/^Flat \*/)).toBeEnabled())
  await userEvent.selectOptions(screen.getByLabelText(/^Flat \*/), 'fl1')

  // Everything the API needs is set, but the ID consent has not been ticked
  expect(submit).toBeDisabled()
  await userEvent.click(screen.getByRole('checkbox'))
  expect(submit).toBeEnabled()
})

it('sends the profile details along with the registration', async () => {
  mocked.registerResident.mockResolvedValue({} as never)
  show()
  await fillRequired()

  await userEvent.type(screen.getByLabelText(/Date of birth/), '1990-04-17')
  await userEvent.selectOptions(screen.getByLabelText(/Gender/), 'FEMALE')
  await userEvent.selectOptions(screen.getByLabelText(/Preferred language/), 'mr')
  await userEvent.type(screen.getByLabelText(/Alternate mobile/), '9833333333')
  await userEvent.type(screen.getByLabelText(/Relationship to flat/), 'Self')
  await userEvent.type(screen.getByLabelText(/^Name/), 'Vikram Joshi')
  await userEvent.click(screen.getByRole('button', { name: 'Register resident' }))

  await waitFor(() =>
    expect(mocked.registerResident).toHaveBeenCalledWith(
      'token',
      'fl1',
      expect.objectContaining({
        name: 'Arjun Nair',
        phone: '9876543216',
        dateOfBirth: '1990-04-17',
        gender: 'FEMALE',
        preferredLanguage: 'mr',
        alternatePhone: '9833333333',
        relationship: 'Self',
        emergencyContactName: 'Vikram Joshi',
      }),
    ),
  )
})

it('hands the Admin a one-time login code for a new account', async () => {
  mocked.registerResident.mockResolvedValue({
    loginCode: { code: 'MWRT-4K9P-2BHD', expiresAt: '2026-10-26T10:00:00.000Z', user: { id: 'u1', name: 'Arjun Nair' } },
  } as never)
  show()
  await fillRequired()
  await userEvent.click(screen.getByRole('button', { name: 'Register resident' }))

  expect(await screen.findByText('MWRT-4K9P-2BHD')).toBeInTheDocument()
  expect(screen.getByText(/One-time login code for Arjun Nair/)).toBeInTheDocument()
  expect(screen.getByText(/does not send messages yet/)).toBeInTheDocument()
})

it('shows no code when the person already had an account', async () => {
  mocked.registerResident.mockResolvedValue({ loginCode: null } as never)
  show()
  await fillRequired()
  await userEvent.click(screen.getByRole('button', { name: 'Register resident' }))

  await screen.findByText(/Arjun Nair/)
  expect(screen.queryByText(/One-time login code/)).not.toBeInTheDocument()
})

it('asks for a lease end date only for a tenant', async () => {
  show()
  await screen.findByLabelText(/Resident type/)

  expect(screen.queryByLabelText(/Lease end date/)).not.toBeInTheDocument()
  await userEvent.selectOptions(screen.getByLabelText(/Resident type/), 'TENANT')
  expect(screen.getByLabelText(/Lease end date/)).toBeInTheDocument()
})

it('preselects the flat passed in from the Residents tab', async () => {
  show('/admin/add-user?flat=fl1')

  await waitFor(() => expect(screen.getByLabelText(/^Block/)).toHaveValue('b1'))
  expect(screen.getByLabelText(/^Flat \*/)).toHaveValue('fl1')
})

it('keeps a field error from the server beside its field', async () => {
  mocked.registerResident.mockRejectedValue(
    new ApiError('VALIDATION_ERROR', 'Request validation failed', undefined, [
      { field: 'phone', message: 'Phone must be a 10-digit Indian mobile number' },
    ]),
  )
  show()
  await fillRequired()
  await userEvent.click(screen.getByRole('button', { name: 'Register resident' }))

  expect(await screen.findByText('Phone must be a 10-digit Indian mobile number')).toBeInTheDocument()
})
