import AxeBuilder from '@axe-core/playwright'
import { expect, request, test, type Page } from '@playwright/test'

// Seeded by `npm run db:seed` in backend (see global-setup.ts)
const accounts = {
  RESIDENT: { phone: '9876543210', password: 'Resident@123', label: 'Resident', area: '/resident/overview', name: 'Riya Sharma' },
  GUARD: { phone: '9876543211', password: 'Guard@123', label: 'Guard', area: '/guard/operations', name: 'Mahesh Patil' },
  ADMIN: { phone: '9876543212', password: 'Admin@123', label: 'Admin', area: '/admin/overview', name: 'Anita Rao' },
}
const INACTIVE = { phone: '9876543213', password: 'Inactive@123' }

/** Desktop and tablet log out from the account menu; mobile from the navigation drawer. */
async function logOut(page: Page) {
  const account = page.getByLabel('Account menu')
  await ((await account.isVisible()) ? account : page.getByRole('button', { name: 'Open menu' })).click()
  await page.getByRole('button', { name: 'Log out' }).filter({ visible: true }).click()
}

async function signIn(page: Page, phone: string, password: string, roleLabel = 'Resident') {
  await page.locator('fieldset label', { hasText: roleLabel }).click()
  await page.getByLabel('Phone number').fill(phone)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

// The app renders nothing until its session-restore call answers, so wait for the form
async function openLogin(page: Page) {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Sign in to CivicKey' })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await openLogin(page)
})

test('AUTH-UI-001/002 login page renders without errors or horizontal scroll', async ({ page }) => {
  const errors: string[] = []
  // A signed-out visitor's session-restore call gets a 401, which browsers log as a failed resource
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/status of 401/.test(msg.text())) errors.push(msg.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await openLogin(page)

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
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    for (const other of Object.values(accounts).filter((a) => a !== account)) {
      await page.evaluate((path) => {
        window.history.pushState(null, '', path)
        window.dispatchEvent(new PopStateEvent('popstate'))
      }, other.area)
      await expect(page.getByRole('heading', { name: 'You don’t have access to this area' })).toBeVisible()
      await expect(page.getByRole('link', { name: `Back to ${account.label} dashboard` })).toBeVisible()
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

test('AUTH-UI-024 reloading the page keeps the user signed in', async ({ page }) => {
  await signIn(page, accounts.RESIDENT.phone, accounts.RESIDENT.password)
  await expect(page).toHaveURL(accounts.RESIDENT.area)

  await page.reload()
  await expect(page).toHaveURL(accounts.RESIDENT.area)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})

test('AUTH-UI-022/023 logout ends the session and protected pages redirect to login', async ({ page }) => {
  await signIn(page, accounts.GUARD.phone, accounts.GUARD.password, accounts.GUARD.label)
  await expect(page).toHaveURL(accounts.GUARD.area)

  const logout = page.waitForResponse('**/api/v1/auth/logout')
  await logOut(page)
  expect((await logout).status()).toBe(200)
  await expect(page).toHaveURL('/login')

  // A fresh page load can't restore it either: the server revoked the session
  await page.goto(accounts.GUARD.area)
  await expect(page).toHaveURL('/login')
})

test.describe('session expiry', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install()
    await openLogin(page)
  })

  test('AUTH-UI-020 the access token is refreshed before it expires', async ({ page }) => {
    await signIn(page, accounts.ADMIN.phone, accounts.ADMIN.password, accounts.ADMIN.label)
    await expect(page).toHaveURL(accounts.ADMIN.area)

    const refreshed = page.waitForResponse('**/api/v1/auth/refresh')
    await page.clock.fastForward('14:00')
    expect((await refreshed).status()).toBe(200)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })

  test('AUTH-UI-021 a revoked session returns the user to login with a message', async ({ page, context, baseURL }) => {
    await signIn(page, accounts.RESIDENT.phone, accounts.RESIDENT.password)
    await expect(page).toHaveURL(accounts.RESIDENT.area)

    // Someone else uses this browser's refresh token first, so the browser's copy is now a reused token
    const cookie = (await context.cookies()).find((c) => c.name === 'ck_refresh')!
    const attacker = await request.newContext({ baseURL })
    const stolen = await attacker.post('/api/v1/auth/refresh', { headers: { Cookie: `ck_refresh=${cookie.value}` } })
    expect(stolen.status()).toBe(200)
    await attacker.dispose()

    const refreshed = page.waitForResponse('**/api/v1/auth/refresh')
    await page.clock.fastForward('14:00')
    expect((await refreshed).status()).toBe(401)
    await expect(page).toHaveURL('/login')
    await expect(page.getByRole('alert')).toHaveText('Your session has ended. Please sign in again.')
  })
})

test.describe('role dashboards', () => {
  test('a committee member sees only their committee destinations', async ({ page }) => {
    // Seeded Tenant on the committee: ADMIN role with committee permissions only
    await signIn(page, '9876543214', 'Committee@123', 'Admin')

    await expect(page).toHaveURL('/admin/overview')
    await expect(page.getByRole('heading', { name: 'Community overview' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Add user' })).toHaveCount(0)
    if (await page.getByRole('button', { name: 'Open menu' }).isVisible()) {
      await page.getByRole('button', { name: 'Open menu' }).click()
    }
    const nav = page.getByRole('navigation', { name: 'Main navigation' }).filter({ visible: true })
    // Their four committee destinations, plus the resident ones they keep as a tenant of their flat.
    // Community tasks is absent: that needs SOCIETY_MANAGE, which a committee member does not hold.
    await expect(nav.getByRole('link')).toHaveText([
      'Overview',
      'Billing',
      'Reports',
      'My flat',
      'Visitor approval',
      'Bills & payments',
      'My activity',
    ])
  })

  test('a guard dashboard has no billing or admin destinations and no accessibility violations', async ({ page }) => {
    await signIn(page, accounts.GUARD.phone, accounts.GUARD.password, accounts.GUARD.label)

    await expect(page.getByRole('heading', { name: 'Gate operations' })).toBeVisible()
    await expect(page.locator('body')).not.toContainText(/Bill|Society & users|Audit/)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  })

  test('a guard typing a billing or resident-management URL is denied', async ({ page }) => {
    await signIn(page, accounts.GUARD.phone, accounts.GUARD.password, accounts.GUARD.label)
    await expect(page).toHaveURL(accounts.GUARD.area)

    for (const path of ['/admin/billing', '/admin/society', '/resident/bills']) {
      await page.goto(path)
      await expect(page.getByRole('heading', { name: 'You don’t have access to this area' })).toBeVisible()
      await expect(page.getByText(path, { exact: true })).toBeVisible()
    }
  })

  test('opening an admin page as a resident shows Access Denied with a way back', async ({ page }) => {
    await signIn(page, accounts.RESIDENT.phone, accounts.RESIDENT.password)
    await expect(page).toHaveURL(accounts.RESIDENT.area)

    await page.goto('/admin/reports')
    await expect(page.getByRole('heading', { name: 'You don’t have access to this area' })).toBeVisible()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.getByRole('link', { name: 'Back to Resident dashboard' }).click()
    await expect(page).toHaveURL(accounts.RESIDENT.area)
  })
})
