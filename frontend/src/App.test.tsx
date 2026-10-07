import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

beforeEach(() => window.history.replaceState(null, '', '/'))
afterEach(() => vi.unstubAllGlobals())

describe('App routing', () => {
  it('sends a signed-out visitor to /login, even from a protected URL', () => {
    window.history.replaceState(null, '', '/admin')
    render(<App />)

    expect(window.location.pathname).toBe('/login')
    expect(screen.getByRole('heading', { name: 'Sign in to CivicKey' })).toBeInTheDocument()
  })

  it.each([
    ['ADMIN', '/admin', 'Admin area'],
    ['RESIDENT', '/resident', 'Resident area'],
    ['GUARD', '/guard', 'Guard area'],
  ])('sends a %s to %s after login', async (role, path, area) => {
    const data = { accessToken: 'jwt', expiresIn: 900, user: { id: 'u1', name: 'Riya', role, societyId: null } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }), { status: 200 })))
    render(<App />)

    await userEvent.click(screen.getByRole('radio', { name: area.replace(' area', '') }))
    await userEvent.type(screen.getByLabelText('Phone number'), '9876543210')
    await userEvent.type(screen.getByLabelText('Password'), 'Resident@123')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: area })).toBeInTheDocument()
    expect(window.location.pathname).toBe(path)
    expect(screen.getByText('Signed in as Riya')).toBeInTheDocument()
  })
})
