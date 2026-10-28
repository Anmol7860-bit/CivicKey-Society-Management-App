import { expect, type Page } from '@playwright/test'

/** Seeded by `npm run db:seed` in backend (see global-setup.ts) */
export const accounts = {
  RESIDENT: { phone: '9876543210', password: 'Resident@123', label: 'Resident', area: '/resident/overview', name: 'Riya Sharma' },
  GUARD: { phone: '9876543211', password: 'Guard@123', label: 'Guard', area: '/guard/operations', name: 'Mahesh Patil' },
  ADMIN: { phone: '9876543212', password: 'Admin@123', label: 'Admin', area: '/admin/overview', name: 'Anita Rao' },
}

export async function signIn(page: Page, phone: string, password: string, roleLabel = 'Resident') {
  await page.locator('fieldset label', { hasText: roleLabel }).click()
  await page.getByLabel('Phone number').fill(phone)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/** The app renders nothing until its session-restore call answers, so wait for the form */
export async function openLogin(page: Page) {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Sign in to CivicKey' })).toBeVisible()
}
