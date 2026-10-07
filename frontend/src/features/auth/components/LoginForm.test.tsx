import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LoginForm } from './LoginForm'

describe('LoginForm', () => {
  it('renders the default sign-in form', () => {
    render(<LoginForm />)

    expect(screen.getByRole('heading', { name: 'Sign in to CivicKey' })).toBeInTheDocument()
    expect(screen.getByLabelText('Phone number')).toHaveAttribute('placeholder', 'xxxxx xxxxx')
    expect(screen.getByText('+91')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Resident' })).toBeChecked()
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('formats the phone number the Indian way and keeps only 10 digits', async () => {
    render(<LoginForm />)
    const phone = screen.getByLabelText('Phone number')

    await userEvent.type(phone, '98a765432109')

    expect(phone).toHaveValue('98765 43210')
  })

  it('drops a pasted +91 country code', async () => {
    render(<LoginForm />)
    const phone = screen.getByLabelText('Phone number')

    await userEvent.click(phone)
    await userEvent.paste('+91 98765 43210')

    expect(phone).toHaveValue('98765 43210')
  })

  it('toggles password visibility', async () => {
    render(<LoginForm />)
    const password = screen.getByLabelText('Password')

    await userEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(password).toHaveAttribute('type', 'text')

    await userEvent.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(password).toHaveAttribute('type', 'password')
  })

  it('submits unformatted phone digits, the password and the selected role', async () => {
    const onSubmit = vi.fn()
    render(<LoginForm onSubmit={onSubmit} />)

    await userEvent.click(screen.getByRole('radio', { name: 'Guard' }))
    await userEvent.type(screen.getByLabelText('Phone number'), '9876543210')
    await userEvent.type(screen.getByLabelText('Password'), 'secret-pass')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(onSubmit).toHaveBeenCalledWith({ phone: '9876543210', password: 'secret-pass', role: 'GUARD' })
  })

  it('rejects a number that is not an Indian mobile number', async () => {
    const onSubmit = vi.fn()
    render(<LoginForm onSubmit={onSubmit} />)

    await userEvent.type(screen.getByLabelText('Phone number'), '5876543210')
    await userEvent.type(screen.getByLabelText('Password'), 'secret-pass')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid 10-digit Indian mobile number.')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('blocks submit and explains an incomplete phone or empty password', async () => {
    const onSubmit = vi.fn()
    render(<LoginForm onSubmit={onSubmit} />)

    await userEvent.type(screen.getByLabelText('Phone number'), '98765')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid 10-digit Indian mobile number.')

    await userEvent.type(screen.getByLabelText('Phone number'), '43210')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your password.')

    expect(onSubmit).not.toHaveBeenCalled()
  })
})
