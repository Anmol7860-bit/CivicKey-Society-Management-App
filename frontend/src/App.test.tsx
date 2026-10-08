import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import App from './App'

async function signInAs(role: string, label: string) {
  const data = { accessToken: 'secret-access-jwt', expiresIn: 900, user: { id: 'u1', name: 'Riya', role, societyId: null } }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }), { status: 200 })))
  render(<App />)
  await userEvent.click(screen.getByRole('radio', { name: label }))
  await userEvent.type(screen.getByLabelText('Phone number'), '9876543210')
  await userEvent.type(screen.getByLabelText('Password'), 'Resident@123')
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

function visit(path: string) {
  act(() => {
    window.history.pushState(null, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
}

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

  it.each([
    ['ADMIN', 'Admin', '/admin', ['/resident', '/guard']],
    ['RESIDENT', 'Resident', '/resident', ['/admin', '/guard']],
    ['GUARD', 'Guard', '/guard', ['/admin', '/resident']],
  ])('keeps a %s out of other roles’ areas', async (role, label, home, others) => {
    await signInAs(role, label)
    await screen.findByRole('heading', { name: `${label} area` })

    for (const path of others) {
      visit(path)
      expect(window.location.pathname).toBe(home)
    }
  })

  it('keeps the access token out of browser storage', async () => {
    await signInAs('RESIDENT', 'Resident')
    await screen.findByRole('heading', { name: 'Resident area' })

    const stored = JSON.stringify({ ...localStorage, ...sessionStorage }) + document.cookie
    expect(stored).not.toContain('secret-access-jwt')
    expect(document.body.textContent).not.toContain('secret-access-jwt')
  })
})
