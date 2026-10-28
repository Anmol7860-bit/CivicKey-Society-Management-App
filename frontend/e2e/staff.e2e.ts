import { expect, test, type Page } from '@playwright/test'
import { accounts, openLogin, signIn } from './accounts'

// Every test here registers a guard in the shared database, so it runs on one browser only.
// The screens themselves are checked for layout by the auth spec on all six.
test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'One browser is enough: these tests write staff rows')
  await openLogin(page)
  await signIn(page, accounts.ADMIN.phone, accounts.ADMIN.password, accounts.ADMIN.label)
  await expect(page).toHaveURL(accounts.ADMIN.area)
  await page.goto('/admin/staff')
  await expect(page.getByRole('heading', { name: 'Staff management' })).toBeVisible()
})

/** A mobile number nobody else holds, so a run never collides with the seed or another run */
function newGuard() {
  const phone = `9${String(Date.now()).slice(-9)}`
  return { name: `Gate Tester ${phone.slice(-4)}`, phone }
}

// The society asks for a photograph of every staff member: a 1x1 PNG is a valid one
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const rowFor = (page: Page, phone: string) => page.getByTestId('staff-row').filter({ hasText: phone })

async function registerGuard(page: Page, guard: { name: string; phone: string }) {
  await page.getByRole('button', { name: 'Add staff' }).click()
  const form = page.locator('form')
  await form.getByLabel('Full name').fill(guard.name)
  await form.getByLabel('Mobile number').fill(guard.phone)
  // By id: 'Gate' also matches the consent text, and the list above has its own Shift filter
  await form.locator('#staff-gate').selectOption({ index: 1 })
  await form.locator('#staff-shift-field').selectOption('MORNING')
  await form.locator('#staff-photo').setInputFiles({ name: 'guard.png', mimeType: 'image/png', buffer: PNG })
  await expect(form.getByRole('img', { name: 'Photo' })).toBeVisible()
  await form.getByRole('checkbox', { name: /agreed to share their photo/ }).check()
  await form.getByRole('button', { name: 'Save and issue staff pass' }).click()
  await expect(rowFor(page, guard.phone)).toBeVisible()
}

test('a registered guard has no login until the Admin creates one', async ({ page }) => {
  const guard = newGuard()
  await registerGuard(page, guard)
  const row = rowFor(page, guard.phone)
  await expect(row.getByText('No login yet')).toBeVisible()

  await row.getByRole('button', { name: 'Create login' }).click()

  // The code is shown once, for the office to hand over; CivicKey sends no messages
  await expect(page.getByText(`One-time login code for ${guard.name}`)).toBeVisible()
  await expect(page.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)).toBeVisible()
  await expect(row.getByText('Can sign in')).toBeVisible()
  await expect(row.getByRole('button', { name: 'Create login' })).toHaveCount(0)
})

test('creating the login posts the guard to their gate', async ({ page }) => {
  const guard = newGuard()
  await registerGuard(page, guard)
  const row = rowFor(page, guard.phone)
  await row.getByRole('button', { name: 'Create login' }).click()
  // The list reloads behind the code panel; clicking before it settles hits a replaced row
  await expect(row.getByText('Can sign in')).toBeVisible()

  await row.getByRole('button', { name: 'Gate postings' }).click()

  await expect(row.getByText(/· \d{2}\/\d{2}\/\d{4} to now$/)).toBeVisible()
})

test('deactivating blocks the login and reactivating gives it back', async ({ page }) => {
  const guard = newGuard()
  await registerGuard(page, guard)
  const row = rowFor(page, guard.phone)
  await row.getByRole('button', { name: 'Create login' }).click()
  await expect(row.getByText('Can sign in')).toBeVisible()

  await row.getByRole('button', { name: 'Deactivate' }).click()
  await page.getByLabel('Reason').fill('Left the agency')
  await page.getByRole('button', { name: 'Deactivate' }).last().click()

  await expect(row.getByText('Login blocked')).toBeVisible()
  await expect(row.getByText('Inactive')).toBeVisible()
  // The Status filter is the only way back to someone who has left
  await page.getByLabel('Status').selectOption('INACTIVE')
  await expect(rowFor(page, guard.phone)).toBeVisible()

  await rowFor(page, guard.phone).getByRole('button', { name: 'Reactivate' }).click()
  await page.getByLabel('Status').selectOption('ACTIVE')
  await expect(rowFor(page, guard.phone).getByText('Can sign in')).toBeVisible()
})
