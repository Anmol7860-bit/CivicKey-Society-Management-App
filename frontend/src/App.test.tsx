import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import App from './App'

type Reply = { status: number; body: unknown } | Error
type Endpoint = 'login' | 'refresh' | 'logout'

const ok = (data: unknown): Reply => ({ status: 200, body: { data } })
const fail = (status: number, code: string): Reply => ({ status, body: { error: { code, message: 'x' } } })
const session = (role = 'RESIDENT', accessToken = 'jwt-1') => ({
  accessToken,
  expiresIn: 900,
  user: { id: 'u1', name: 'Riya', role, societyId: null, permissions: [] },
})

/** Fakes the auth API. Each endpoint plays its replies in order and repeats the last one. Refresh defaults to "no cookie". */
function fakeApi(replies: Partial<Record<Endpoint, Reply[]>> = {}) {
  const queues = { refresh: [fail(401, 'INVALID_REFRESH_TOKEN')], login: [fail(500, 'INTERNAL_ERROR')], logout: [ok({ loggedOut: true })], ...replies }
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    const queue = queues[url.split('/').pop() as Endpoint]
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!
    if (reply instanceof Error) throw reply
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function callsTo(fetch: ReturnType<typeof fakeApi>, endpoint: Endpoint) {
  return fetch.mock.calls.filter(([url]) => url.endsWith(`/${endpoint}`))
}

async function signInAs(role: string) {
  fakeApi({ login: [ok(session(role, 'secret-access-jwt'))] })
  render(<App />)
  await userEvent.type(await screen.findByLabelText('Phone number'), '9876543210')
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
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('App routing', () => {
  it('sends a signed-out visitor to /login, even from a protected URL', async () => {
    fakeApi()
    window.history.replaceState(null, '', '/admin')
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Sign in to CivicKey' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
  })

  it.each([
    ['ADMIN', '/admin/overview', 'Community overview'],
    ['RESIDENT', '/resident/overview', /, Riya$/],
    ['GUARD', '/guard/operations', 'Gate operations'],
  ])('sends a %s to their dashboard after login', async (role, path, heading) => {
    await signInAs(role)

    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument()
    expect(window.location.pathname).toBe(path)
    expect(screen.getByText('Signed in as Riya')).toBeInTheDocument()
  })

  it.each([
    ['ADMIN', 'Admin', ['/resident/overview', '/guard/operations']],
    ['RESIDENT', 'Resident', ['/admin/overview', '/guard/operations']],
    ['GUARD', 'Guard', ['/admin/overview', '/resident/overview']],
  ])('shows Access Denied when a %s opens another role’s area', async (role, label, others) => {
    await signInAs(role)
    await screen.findByRole('navigation', { name: 'Main navigation' })

    for (const path of others) {
      visit(path)
      expect(await screen.findByRole('heading', { name: 'You don’t have access to this area' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: `Back to ${label} dashboard` })).toBeInTheDocument()
    }
  })

  it('keeps the access token out of browser storage', async () => {
    await signInAs('RESIDENT')
    await screen.findByRole('heading', { name: /, Riya$/ })

    const stored = JSON.stringify({ ...localStorage, ...sessionStorage }) + document.cookie
    expect(stored).not.toContain('secret-access-jwt')
    expect(document.body.textContent).not.toContain('secret-access-jwt')
  })
})

describe('session', () => {
  it('restores the session from the refresh cookie after a page reload', async () => {
    const fetch = fakeApi({ refresh: [ok(session('GUARD'))] })
    window.history.replaceState(null, '', '/guard/operations')
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Gate operations' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/guard/operations')
    expect(callsTo(fetch, 'login')).toHaveLength(0)
  })

  it('refreshes the access token a minute before it expires and stays signed in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetch = fakeApi({ refresh: [ok(session('RESIDENT', 'jwt-1')), ok(session('RESIDENT', 'jwt-2'))] })
    render(<App />)
    await screen.findByRole('heading', { name: /, Riya$/ })

    await act(() => vi.advanceTimersByTimeAsync(839_000))
    expect(callsTo(fetch, 'refresh')).toHaveLength(1)
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    expect(callsTo(fetch, 'refresh')).toHaveLength(2)

    expect(screen.getByRole('heading', { name: /, Riya$/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
    await screen.findByRole('heading', { name: 'Sign in to CivicKey' })
    expect(callsTo(fetch, 'logout')[0]![1]!.headers).toEqual({ Authorization: 'Bearer jwt-2' })
  })

  it.each([
    ['expired', fail(401, 'SESSION_EXPIRED')],
    ['revoked', fail(401, 'INVALID_REFRESH_TOKEN')],
  ])('returns to login with a message when the session is %s', async (_case, reply) => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fakeApi({ refresh: [ok(session()), reply] })
    render(<App />)
    await screen.findByRole('heading', { name: /, Riya$/ })

    await act(() => vi.advanceTimersByTimeAsync(840_000))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has ended. Please sign in again.')
    expect(window.location.pathname).toBe('/login')
  })

  it('stays signed in through a network failure and retries the refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fetch = fakeApi({ refresh: [ok(session()), new TypeError('Failed to fetch'), ok(session())] })
    render(<App />)
    await screen.findByRole('heading', { name: /, Riya$/ })

    await act(() => vi.advanceTimersByTimeAsync(840_000))
    expect(screen.getByRole('heading', { name: /, Riya$/ })).toBeInTheDocument()

    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(callsTo(fetch, 'refresh')).toHaveLength(3)
    expect(screen.getByRole('heading', { name: /, Riya$/ })).toBeInTheDocument()
  })
})

describe('logout', () => {
  it('revokes the session, returns to login and blocks protected pages', async () => {
    const fetch = fakeApi({ refresh: [ok(session('ADMIN'))] })
    render(<App />)

    await userEvent.click(await screen.findByRole('button', { name: 'Log out' }))

    expect(await screen.findByRole('heading', { name: 'Sign in to CivicKey' })).toBeInTheDocument()
    expect(callsTo(fetch, 'logout')[0]![1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer jwt-1' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    visit('/admin/overview')
    expect(window.location.pathname).toBe('/login')
  })

  it('refreshes an expired access token so the server session is still revoked', async () => {
    const fetch = fakeApi({
      refresh: [ok(session('RESIDENT', 'jwt-1')), ok(session('RESIDENT', 'jwt-2'))],
      logout: [fail(401, 'TOKEN_EXPIRED'), ok({ loggedOut: true })],
    })
    render(<App />)

    await userEvent.click(await screen.findByRole('button', { name: 'Log out' }))

    await screen.findByRole('heading', { name: 'Sign in to CivicKey' })
    expect(callsTo(fetch, 'logout').map(([, init]) => init!.headers)).toEqual([
      { Authorization: 'Bearer jwt-1' },
      { Authorization: 'Bearer jwt-2' },
    ])
  })

  it('still signs out locally when the logout request fails', async () => {
    fakeApi({ refresh: [ok(session())], logout: [new TypeError('Failed to fetch')] })
    render(<App />)

    await userEvent.click(await screen.findByRole('button', { name: 'Log out' }))

    expect(await screen.findByRole('heading', { name: 'Sign in to CivicKey' })).toBeInTheDocument()
  })
})
