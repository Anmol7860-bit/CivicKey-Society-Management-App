import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AdminAccounts } from './AdminAccounts'
import * as api from './api'
import type { AdminAccount, Resident } from './api'

// The permission lists are real; only the calls are replaced
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listAdmins: vi.fn(),
  listResidents: vi.fn(),
  createAdmin: vi.fn(),
  setCommitteePermissions: vi.fn(),
  removeCommitteePermissions: vi.fn(),
}))
const mocked = vi.mocked(api)

const anAdmin = (overrides: Partial<AdminAccount> = {}): AdminAccount => ({
  id: 'u1',
  name: 'Anita Rao',
  phone: '9876543212',
  email: null,
  isActive: true,
  resident: false,
  idDocumentType: 'AADHAAR',
  idDocumentLast4: '9012',
  idDocumentOnFile: true,
  permissions: ['USER_MANAGE'],
  ...overrides,
})

const aResident = (overrides: Partial<Resident> = {}) =>
  ({
    id: 'a1',
    userId: 'u2',
    flatId: 'fl1',
    user: { id: 'u2', name: 'Vikram Joshi', phone: '9876543214', email: null },
    block: { id: 'b1', name: 'B' },
    flat: { id: 'fl1', number: '204' },
    permissions: [],
    ...overrides,
  }) as Resident

beforeEach(() => {
  vi.resetAllMocks()
  mocked.listAdmins.mockResolvedValue([anAdmin()])
  mocked.listResidents.mockResolvedValue([aResident()])
})

const show = () => render(<AdminAccounts accessToken="token" societyId="s1" />)

it('creates the account with the permissions that were ticked, and hands over the code', async () => {
  mocked.createAdmin.mockResolvedValue({
    user: { id: 'u3', name: 'Nisha Kulkarni', phone: '9700000001', email: null, idDocumentType: 'AADHAAR', idDocumentLast4: '9012', idDocumentOnFile: true },
    permissions: ['SOCIETY_MANAGE'],
    loginCode: { code: '4821', expiresAt: '2026-11-02T10:00:00.000Z', user: { id: 'u3', name: 'Nisha Kulkarni' } },
  })
  show()

  const submit = await screen.findByRole('button', { name: 'Create the Admin account' })
  expect(submit).toBeDisabled()
  await userEvent.type(screen.getByLabelText(/Full name/), 'Nisha Kulkarni')
  await userEvent.type(screen.getByLabelText(/Mobile number/), '9700000001')
  // Nothing ticked yet, so there is nothing this Admin could do
  expect(submit).toBeDisabled()

  await userEvent.selectOptions(screen.getByLabelText(/ID type/), 'AADHAAR')
  await userEvent.type(screen.getByLabelText(/^ID number/), '123456789012')
  expect(screen.getByLabelText(/^ID number/)).toHaveAttribute('type', 'password')
  await userEvent.click(screen.getByRole('checkbox', { name: /agreed to share this ID/ }))
  // The document is recorded, but the account still may not do anything
  expect(submit).toBeDisabled()

  await userEvent.click(screen.getByRole('checkbox', { name: /Society, blocks and flats/ }))
  // Reports is offered twice on the page: here, and again for a committee member
  await userEvent.click(screen.getAllByRole('checkbox', { name: /Reports/ })[0]!)
  expect(submit).toBeEnabled()
  await userEvent.click(submit)

  await waitFor(() =>
    expect(mocked.createAdmin).toHaveBeenCalledWith('token', 's1', {
      name: 'Nisha Kulkarni',
      phone: '9700000001',
      permissions: ['SOCIETY_MANAGE', 'REPORT_VIEW'],
      idDocumentType: 'AADHAAR',
      idNumber: '123456789012',
    }),
  )
  expect(await screen.findByText('4821')).toBeInTheDocument()
})

it('says what the disabled create button is still waiting for', async () => {
  show()
  await screen.findByRole('button', { name: 'Create the Admin account' })

  expect(screen.getByText(/Still needed: full name, mobile number, ID type, ID number, the consent tick, at least one permission/)).toBeInTheDocument()
  await userEvent.type(screen.getByLabelText(/Full name/), 'Nisha Kulkarni')
  expect(screen.getByText(/Still needed: mobile number/)).toBeInTheDocument()
})

it('never offers a gate or resident permission', async () => {
  show()
  await screen.findByRole('button', { name: 'Create the Admin account' })

  expect(screen.queryByRole('checkbox', { name: /visitor/i })).not.toBeInTheDocument()
  // 10 assignable permissions, the consent tick, and the four committee boxes again below
  expect(screen.getAllByRole('checkbox')).toHaveLength(15)
})

it('gives a resident committee access from the list of residents', async () => {
  mocked.setCommitteePermissions.mockResolvedValue({ userId: 'u2', permissions: ['REPORT_VIEW'] })
  show()

  const save = await screen.findByRole('button', { name: 'Save committee access' })
  expect(save).toBeDisabled()
  await userEvent.selectOptions(screen.getByLabelText('Resident'), 'u2')
  const [, committeeReport] = screen.getAllByRole('checkbox', { name: /Reports/ })
  await userEvent.click(committeeReport!)
  await userEvent.click(save)

  await waitFor(() => expect(mocked.setCommitteePermissions).toHaveBeenCalledWith('token', 'u2', ['REPORT_VIEW']))
  expect(await screen.findByText('Vikram Joshi now has committee access.')).toBeInTheDocument()
})

it('offers to take committee access back from someone who has it', async () => {
  mocked.listAdmins.mockResolvedValue([anAdmin({ id: 'u2', name: 'Vikram Joshi', resident: true, permissions: ['REPORT_VIEW'] })])
  mocked.removeCommitteePermissions.mockResolvedValue({ userId: 'u2', permissions: [] })
  show()

  await userEvent.selectOptions(await screen.findByLabelText('Resident'), 'u2')
  await userEvent.click(screen.getByRole('button', { name: 'Remove committee access' }))

  await waitFor(() => expect(mocked.removeCommitteePermissions).toHaveBeenCalledWith('token', 'u2'))
})

it('lists who is an Admin today and what they hold', async () => {
  show()

  await screen.findByText('Anita Rao')

  expect(screen.getByRole('listitem')).toHaveTextContent('Anita Rao9876543212OfficeAadhaar ····9012 on fileResidents and accounts')
})
