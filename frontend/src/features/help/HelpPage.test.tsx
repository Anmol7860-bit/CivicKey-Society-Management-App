import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HelpPage } from './HelpPage'
import type { AuthUser } from '../auth/api'

const user: AuthUser = {
  id: 'u1',
  name: 'Riya Sharma',
  phone: '9876543210',
  email: null,
  role: 'RESIDENT',
  societyId: 's1',
  permissions: [],
}

it('fills the report with what support asks for, and holds it back until it says something', async () => {
  render(<HelpPage user={user} />)

  const copy = screen.getByRole('button', { name: /Copy report/ })
  expect(copy).toBeDisabled()

  await userEvent.type(screen.getByLabelText(/What happened/), 'The gate log is empty after I sign in')

  const report = screen.getByLabelText('Your report')
  expect(report).toHaveTextContent('The gate log is empty after I sign in')
  expect(report).toHaveTextContent('Role: Resident')
  expect(report).toHaveTextContent('Reported by: Riya Sharma')
  expect(copy).toBeEnabled()
})

it('answers the questions people actually ask', async () => {
  render(<HelpPage user={user} />)

  expect(screen.getByText('I forgot my password. What now?')).toBeInTheDocument()
  expect(screen.getByText(/four-digit code/)).toBeInTheDocument()
})
