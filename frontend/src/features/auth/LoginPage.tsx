import { AuthLayout } from './components/AuthLayout'
import { LoginForm } from './components/LoginForm'

export function LoginPage() {
  return (
    <AuthLayout>
      <LoginForm />
    </AuthLayout>
  )
}
