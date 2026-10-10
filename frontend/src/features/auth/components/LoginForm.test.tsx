import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from '../../../i18n'
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
    expect(screen.getByLabelText('Phone number')).toHaveFocus()

    await userEvent.type(screen.getByLabelText('Phone number'), '43210')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your password.')
    expect(screen.getByLabelText('Password')).toHaveFocus()

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('blocks submit when the phone number is empty', async () => {
    const onSubmit = vi.fn()
    render(<LoginForm onSubmit={onSubmit} />)

    await userEvent.type(screen.getByLabelText('Password'), 'secret-pass')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid 10-digit Indian mobile number.')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('can be filled in and submitted with the keyboard only', async () => {
    const onSubmit = vi.fn()
    render(<LoginForm onSubmit={onSubmit} />)

    await userEvent.tab()
    expect(screen.getByRole('radio', { name: 'Resident' })).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Guard' })).toBeChecked()

    await userEvent.tab()
    expect(screen.getByLabelText('Phone number')).toHaveFocus()
    await userEvent.keyboard('9876543210')
    await userEvent.tab()
    expect(screen.getByLabelText('Password')).toHaveFocus()
    await userEvent.keyboard('secret-pass')
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text')
    await userEvent.tab()
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveFocus()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')

    expect(onSubmit).toHaveBeenCalledWith({ phone: '9876543210', password: 'secret-pass', role: 'GUARD' })
  })

  it('takes every visible string from i18n', async () => {
    // cimode makes t() return the key, so any English left on screen is hard-coded
    await i18n.changeLanguage('cimode')
    try {
      render(<LoginForm />)
      await userEvent.click(screen.getByRole('button', { name: 'auth.login.submit' }))

      expect(screen.getByRole('alert')).toHaveTextContent('auth.login.errors.phoneInvalid')
      const text = document.body.textContent!.replace(/auth\.login\.[\w.]+|\+91/g, '')
      expect(text.trim()).toBe('')
    } finally {
      await i18n.changeLanguage('en')
    }
  })
})
