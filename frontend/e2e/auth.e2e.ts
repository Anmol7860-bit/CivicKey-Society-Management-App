import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Seeded by `npm run db:seed` in backend (see global-setup.ts)
const accounts = {
  RESIDENT: { phone: '9876543210', password: 'Resident@123', label: 'Resident', area: '/resident', name: 'Riya Sharma' },
  GUARD: { phone: '9876543211', password: 'Guard@123', label: 'Guard', area: '/guard', name: 'Mahesh Patil' },
  ADMIN: { phone: '9876543212', password: 'Admin@123', label: 'Admin', area: '/admin', name: 'Anita Rao' },
}
const INACTIVE = { phone: '9876543213', password: 'Inactive@123' }

async function signIn(page: Page, phone: string, password: string, roleLabel = 'Resident') {
  await page.locator('fieldset label', { hasText: roleLabel }).click()
  await page.getByLabel('Phone number').fill(phone)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/login')
})

test('AUTH-UI-001/002 login page renders without errors or horizontal scroll', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()))
  page.on('pageerror', (error) => errors.push(error.message))
  await page.reload()

  for (const control of [
    page.getByLabel('Phone number'),
    page.getByLabel('Password', { exact: true }),
    page.getByRole('button', { name: 'Show password' }),
    page.getByRole('button', { name: 'Sign in' }),
  ]) {
    await expect(control).toBeInViewport()
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test('AUTH-UI-028 login page has no automated accessibility violations', async ({ page }) => {
  const { violations } = await new AxeBuilder({ page }).analyze()
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
})

test('AUTH-UI-003/009 invalid form shows a message and sends no request', async ({ page }) => {
  let loginCalls = 0
  page.on('request', (req) => req.url().includes('/auth/login') && loginCalls++)

  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByRole('alert')).toHaveText('Enter a valid 10-digit Indian mobile number.')
  expect(loginCalls).toBe(0)
})

test('AUTH-UI-006/007/008 password is masked and can be shown and hidden', async ({ page }) => {
  const password = page.getByLabel('Password', { exact: true })
  await password.fill('secret-pass')
  await expect(password).toHaveAttribute('type', 'password')

  await page.getByRole('button', { name: 'Show password' }).click()
  await expect(password).toHaveAttribute('type', 'text')
  await page.getByRole('button', { name: 'Hide password' }).click()
  await expect(password).toHaveAttribute('type', 'password')
})

for (const [role, account] of Object.entries(accounts)) {
  test(`AUTH-UI-011..014 ${role} lands in their own area and cannot open others`, async ({ page }) => {
    await signIn(page, account.phone, account.password, account.label)

    await expect(page).toHaveURL(account.area)
    await expect(page.getByText(`Signed in as ${account.name}`)).toBeVisible()

    for (const other of Object.values(accounts).filter((a) => a !== account)) {
      await page.evaluate((path) => {
        window.history.pushState(null, '', path)
        window.dispatchEvent(new PopStateEvent('popstate'))
      }, other.area)
      await expect(page).toHaveURL(account.area)
    }
  })
}

test('AUTH-UI-015 wrong password keeps the user on login with a clear message', async ({ page }) => {
  await signIn(page, accounts.RESIDENT.phone, 'Wrong@123')

  await expect(page.getByRole('alert')).toHaveText('Incorrect phone number or password.')
  await expect(page).toHaveURL('/login')
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password')
})

test('AUTH-UI-016 inactive account sees the inactive message', async ({ page }) => {
  await signIn(page, INACTIVE.phone, INACTIVE.password)

  await expect(page.getByRole('alert')).toHaveText('This account is inactive. Contact property support.')
  await expect(page).toHaveURL('/login')
})

test('AUTH-UI-019 offline login fails clearly and can be retried once back online', async ({ page, context }) => {
  await context.setOffline(true)
  await signIn(page, accounts.RESIDENT.phone, accounts.RESIDENT.password)

  await expect(page.getByRole('alert')).toHaveText("Can't reach CivicKey. Check your connection and try again.")
  const button = page.getByRole('button', { name: 'Sign in' })
  await expect(button).toBeEnabled()

  await context.setOffline(false)
  await button.click()
  await expect(page).toHaveURL(accounts.RESIDENT.area)
})

test('AUTH-UI-025/026 password and access token never reach browser storage', async ({ page }) => {
  await signIn(page, accounts.RESIDENT.phone, accounts.RESIDENT.password)
  await expect(page).toHaveURL(accounts.RESIDENT.area)

  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }) + document.cookie)
  expect(stored).not.toContain(accounts.RESIDENT.password)
  expect(stored).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/) // no JWT
  // The refresh token must be httpOnly, so scripts can't read it
  expect(stored).not.toContain('ck_refresh')
})

// Known gap: session restore via /auth/refresh is not built yet (in-memory session only)
test.fixme('AUTH-UI-024 reloading the page keeps the user signed in', async ({ page }) => {
  await signIn(page, accounts.RESIDENT.phone, accounts.RESIDENT.password)
  await expect(page).toHaveURL(accounts.RESIDENT.area)

  await page.reload()
  await expect(page).toHaveURL(accounts.RESIDENT.area)
})
