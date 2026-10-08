import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LoginPage } from './LoginPage'

function respond(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })))
}

async function signIn() {
  await userEvent.type(screen.getByLabelText('Phone number'), '9876543210')
  await userEvent.type(screen.getByLabelText('Password'), 'Resident@123')
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

afterEach(() => vi.unstubAllGlobals())

describe('LoginPage', () => {
  it('posts the credentials and hands the session to onSignedIn', async () => {
    const session = { accessToken: 'jwt', expiresIn: 900, user: { name: 'Riya' } }
    respond(200, { data: session })
    const onSignedIn = vi.fn()
    render(<LoginPage onSignedIn={onSignedIn} />)

    await signIn()

    expect(fetch).toHaveBeenCalledWith('/api/v1/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ phone: '9876543210', password: 'Resident@123', role: 'RESIDENT' }),
    }))
    expect(onSignedIn).toHaveBeenCalledWith(session)
  })

  it.each([
    [401, 'INVALID_CREDENTIALS', {}, 'Incorrect phone number or password.'],
    [403, 'USER_INACTIVE', {}, 'This account is inactive. Contact property support.'],
    [403, 'ROLE_MISMATCH', {}, 'This account is not registered as Resident. Select the correct role and try again.'],
    [422, 'VALIDATION_ERROR', {}, 'Check your phone number and password, then try again.'],
    [429, 'TOO_MANY_REQUESTS', { retryAfterSeconds: 600 }, 'Too many attempts. Try again in 10 min.'],
    [500, 'INTERNAL_ERROR', {}, 'Something went wrong. Please try again.'],
  ])('shows a message for %i %s', async (status, code, extra, message) => {
    respond(status, { error: { code, message: 'x', ...extra } })
    const onSignedIn = vi.fn()
    render(<LoginPage onSignedIn={onSignedIn} />)

    await signIn()

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('shows a loading state and sends only one request while signing in', async () => {
    let resolve!: (res: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((r) => (resolve = r))))
    const onSignedIn = vi.fn()
    render(<LoginPage onSignedIn={onSignedIn} />)

    await signIn()
    const button = screen.getByRole('button', { name: 'Signing in…' })
    expect(button).toBeDisabled()
    fireEvent.submit(button.closest('form')!)
    fireEvent.submit(button.closest('form')!)
    expect(fetch).toHaveBeenCalledTimes(1)

    resolve(new Response(JSON.stringify({ data: { user: { name: 'Riya' } } }), { status: 200 }))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
  })

  it('keeps the password out of browser storage', async () => {
    respond(200, { data: { accessToken: 'jwt', expiresIn: 900, user: { name: 'Riya' } } })
    const onSignedIn = vi.fn()
    render(<LoginPage onSignedIn={onSignedIn} />)

    await signIn()
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled())

    const stored = JSON.stringify({ ...localStorage, ...sessionStorage }) + document.cookie
    expect(stored).not.toContain('Resident@123')
  })

  it('shows a connection message when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    render(<LoginPage onSignedIn={vi.fn()} />)

    await signIn()

    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach CivicKey.")
  })

  it('recovers from a network failure so the user can retry', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { user: { name: 'Riya' } } }), { status: 200 })))
    const onSignedIn = vi.fn()
    render(<LoginPage onSignedIn={onSignedIn} />)

    await signIn()
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach CivicKey.")
    const button = screen.getByRole('button', { name: 'Sign in' })
    expect(button).toBeEnabled()

    await userEvent.click(button)
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
  })
})
