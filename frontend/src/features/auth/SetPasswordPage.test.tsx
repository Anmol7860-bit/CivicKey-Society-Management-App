import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from './api'
import { SetPasswordPage } from './SetPasswordPage'

vi.mock('./api', async () => ({
  ...(await vi.importActual<typeof api>('./api')),
  forgotPassword: vi.fn(),
  setPassword: vi.fn(),
}))
const mocked = vi.mocked(api)

const CODE = 'MWRT-4K9P-2BHD'

async function fillCode(password = 'Monsoon2026rain', confirm = password) {
  await userEvent.type(screen.getByLabelText(/One-time code/), CODE)
  await userEvent.type(screen.getByLabelText(/New password/), password)
  await userEvent.type(screen.getByLabelText(/Repeat the password/), confirm)
}

beforeEach(() => {
  vi.resetAllMocks()
  render(<SetPasswordPage />)
})

it('sets the password with the code from the office', async () => {
  mocked.setPassword.mockResolvedValue({ passwordSet: true })
  await fillCode()
  await userEvent.click(screen.getByRole('button', { name: 'Set password' }))

  await waitFor(() => expect(mocked.setPassword).toHaveBeenCalledWith(CODE, 'Monsoon2026rain'))
  expect(await screen.findByText('Your password is set')).toBeInTheDocument()
  // The old password is gone, so whoever was signed in with it has to sign in again
  expect(screen.getByText(/signed out/)).toBeInTheDocument()
})

it('will not submit a weak password or a mismatch', async () => {
  const submit = screen.getByRole('button', { name: 'Set password' })

  await fillCode('short1')
  expect(submit).toBeDisabled()
  expect(screen.getByText(/At least 10 characters/)).toBeInTheDocument()

  await userEvent.clear(screen.getByLabelText(/New password/))
  await userEvent.clear(screen.getByLabelText(/Repeat the password/))
  await fillCode('Monsoon2026rain', 'Monsoon2026rainy')
  expect(screen.getByText('Both passwords must match.')).toBeInTheDocument()
  expect(submit).toBeDisabled()
  expect(mocked.setPassword).not.toHaveBeenCalled()
})

it('shows what the server said about a spent code', async () => {
  mocked.setPassword.mockRejectedValue(new api.ApiError('INVALID_CODE', 'That code is not valid any more.'))
  await fillCode()
  await userEvent.click(screen.getByRole('button', { name: 'Set password' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('That code is not valid any more.')
})

it('asks the office for a code without saying whether the number is registered', async () => {
  mocked.forgotPassword.mockResolvedValue({ requested: true })
  const ask = screen.getByRole('button', { name: 'Tell the office' })

  expect(ask).toBeDisabled()
  await userEvent.type(screen.getByLabelText(/Phone number/), '9876543210')
  expect(ask).toBeEnabled()
  await userEvent.click(ask)

  await waitFor(() => expect(mocked.forgotPassword).toHaveBeenCalledWith('9876543210'))
  expect(await screen.findByText('The office has been told')).toBeInTheDocument()
  expect(screen.getByText(/never say whether a number is registered/)).toBeInTheDocument()
})
