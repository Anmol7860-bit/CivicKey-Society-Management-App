import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LoginForm } from './LoginForm'

describe('LoginForm', () => {
  it('renders the default sign-in form', () => {
    render(<LoginForm />)

    expect(screen.getByRole('heading', { name: 'Sign in to CivicKey' })).toBeInTheDocument()
    expect(screen.getByLabelText('Phone number')).toHaveAttribute('placeholder', '(000) 000-0000')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('formats the phone number and keeps only 10 digits', async () => {
    render(<LoginForm />)
    const phone = screen.getByLabelText('Phone number')

    await userEvent.type(phone, '31a2555014899')

    expect(phone).toHaveValue('(312) 555-0148')
  })

  it('toggles password visibility', async () => {
    render(<LoginForm />)
    const password = screen.getByLabelText('Password')

    await userEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(password).toHaveAttribute('type', 'text')

    await userEvent.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(password).toHaveAttribute('type', 'password')
  })

  it('submits unformatted phone digits and the password', async () => {
    const onSubmit = vi.fn()
    render(<LoginForm onSubmit={onSubmit} />)

    await userEvent.type(screen.getByLabelText('Phone number'), '3125550148')
    await userEvent.type(screen.getByLabelText('Password'), 'secret-pass')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(onSubmit).toHaveBeenCalledWith({ phone: '3125550148', password: 'secret-pass' })
  })
})
