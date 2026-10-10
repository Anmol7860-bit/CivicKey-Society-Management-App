import { render, screen, within } from '@testing-library/react'
import type { AuthUser, Permission } from '../auth/api'
import { Dashboard } from './Dashboard'

const user = (role: AuthUser['role'], permissions: Permission[], residentType: AuthUser['residentType'] = null): AuthUser => ({
  id: 'u1',
  name: 'Riya',
  phone: null,
  email: null,
  role,
  residentType,
  societyId: null,
  permissions,
})

function functions() {
  return within(screen.getByRole('list', { name: 'Your functions' }))
    .getAllByRole('heading')
    .map((heading) => heading.textContent)
}

const logout = async () => {}

describe('Dashboard', () => {
  it('shows a Guard only gate functions', () => {
    render(<Dashboard user={user('GUARD', ['VISITOR_REGISTER', 'VISIT_DECIDE', 'VISIT_ENTRY_RECORD', 'VISIT_EXIT_RECORD', 'PASS_VALIDATE'])} onLogout={logout} />)

    expect(functions()).toEqual(['Register visitor', 'Allow or deny entry', 'Record entry', 'Record exit', 'Validate visitor or staff pass'])
  })

  it('shows a Resident their own-flat functions and Resident Type', () => {
    render(<Dashboard user={user('RESIDENT', ['VISITOR_APPROVE', 'OWN_BILLS_VIEW'], 'TENANT')} onLogout={logout} />)

    expect(functions()).toEqual(['Approve visitors', 'My bills'])
    expect(screen.getByText('Tenant')).toBeInTheDocument()
  })

  it('shows a committee member only the committee functions assigned', () => {
    render(<Dashboard user={user('ADMIN', ['BILLING_RATE_SET', 'REPORT_VIEW'], 'OWNER')} onLogout={logout} />)

    expect(screen.getByRole('heading', { name: 'Admin area' })).toBeInTheDocument()
    expect(functions()).toEqual(['Billing rates', 'Reports'])
    expect(screen.queryByText('Users and resident links')).not.toBeInTheDocument()
  })

  it('tells an Admin with no permissions that nothing is assigned', () => {
    render(<Dashboard user={user('ADMIN', [])} onLogout={logout} />)

    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.getByText(/No functions are assigned/)).toBeInTheDocument()
  })
})
