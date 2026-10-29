import { expect, test, type APIRequestContext } from '@playwright/test'
import { accounts, openLogin, signIn } from './accounts'

// Registers a real visit in the shared database, so it runs on one browser. What is under test
// is the live channel, not the layout, and the layout is covered by the auth spec everywhere.
//
// One environment note: a socket event reaches only the clients of the API process that
// dispatched it. A dev backend left running against the same database claims outbox rows too,
// and its emit goes to its own clients, so this test can lose that race. The e2e backend drains
// the queue every second (playwright.config.ts) to stay ahead of a five-second dev loop.
test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'One browser is enough: this test writes a visit')
  await openLogin(page)
  await signIn(page, accounts.RESIDENT.phone, accounts.RESIDENT.password, accounts.RESIDENT.label)
  await expect(page).toHaveURL(accounts.RESIDENT.area)
})

/** The gate photographs every visitor it registers by hand; a 1x1 PNG is a valid photograph */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

interface SignedIn {
  headers: { Authorization: string }
  societyId: string
  userId: string
}

async function signInApi(request: APIRequestContext, account: { phone: string; password: string }, role: string): Promise<SignedIn> {
  const response = await request.post('/api/v1/auth/login', {
    data: { phone: account.phone, password: account.password, role },
  })
  expect(response.ok(), 'the API sign-in should succeed').toBeTruthy()
  const { data } = await response.json()
  return {
    headers: { Authorization: `Bearer ${data.accessToken}` },
    societyId: data.user.societyId as string,
    userId: data.user.id as string,
  }
}

/**
 * Only a *current* resident of a flat is asked to approve its visitors, and the seeded resident's
 * own assignment ends when the database says it does — a move-out is a thing the app records, so
 * a test cannot assume one has not happened.
 *
 * So the test arranges the state it needs through the office's own screens: if the resident holds
 * no current flat, the Admin puts them in an empty one and verifies it. It runs once; every later
 * run finds the assignment already there.
 */
async function currentFlatOf(request: APIRequestContext, resident: SignedIn, guard: SignedIn) {
  const mine = async () => {
    const response = await request.get('/api/v1/me/flats', { headers: resident.headers })
    return (await response.json()).data as { id: string; flatId: string; active: boolean; eligible: boolean }[]
  }
  const held = (await mine()).find((row) => row.active && row.eligible)
  if (held) return held.flatId

  // The flat directory belongs to the gate screens, so it is read with the guard's session
  const directory = await request.get(`/api/v1/societies/${guard.societyId}/flat-directory`, { headers: guard.headers })
  const empty = ((await directory.json()).data as { id: string; label: string; residents: number }[])
    .filter((flat) => Number(flat.residents) === 0)
    .sort((a, b) => a.label.localeCompare(b.label))[0]
  expect(empty, 'the society should have an empty flat to move the resident into').toBeTruthy()

  const admin = await signInApi(request, accounts.ADMIN, 'ADMIN')

  const registered = await request.post(`/api/v1/flats/${empty!.id}/residents`, {
    headers: admin.headers,
    data: {
      name: accounts.RESIDENT.name,
      phone: accounts.RESIDENT.phone,
      residentType: 'OWNER',
      accessLevel: 'FULL',
      startDate: new Date().toISOString().slice(0, 10),
    },
  })
  expect(registered.ok(), await registered.text()).toBeTruthy()
  const verified = await request.post(`/api/v1/residents/${(await registered.json()).data.id}/verify`, {
    headers: admin.headers,
    data: {},
  })
  expect(verified.ok(), await verified.text()).toBeTruthy()

  const now = (await mine()).find((row) => row.active && row.eligible)
  expect(now, 'the resident should hold a flat once the office has verified it').toBeTruthy()
  return now!.flatId
}

/**
 * The guard registers a visitor for this resident's flat, through the API rather than a second
 * browser: the point of the test is what the resident's open page does next, and the guard's own
 * screen has its own coverage.
 */
async function guardRegisters(request: APIRequestContext, visitorName: string) {
  const resident = await signInApi(request, accounts.RESIDENT, 'RESIDENT')
  const guard = await signInApi(request, accounts.GUARD, 'GUARD')
  const flatId = await currentFlatOf(request, resident, guard)

  // The gate form asks when the visitor is expected and who they are here to see
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const photo = await request.post('/api/v1/files', {
    headers: { ...guard.headers, 'Content-Type': 'image/png' },
    data: PNG,
  })
  expect(photo.ok(), 'the gate photograph should be stored').toBeTruthy()

  const visit = await request.post(`/api/v1/societies/${guard.societyId}/visits`, {
    headers: guard.headers,
    data: {
      flatId,
      visitorName,
      visitorPhone: '9870000001',
      purpose: 'GUEST',
      people: 1,
      expectedDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      expectedTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      intendedResidentId: resident.userId,
      photoReference: (await photo.json()).data.id,
    },
  })
  expect(visit.ok(), await visit.text()).toBeTruthy()
}

test('a visitor registered at the gate reaches the resident without a refresh', async ({ page, request }) => {
  await page.goto('/resident/notifications')
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible()

  // Anything this page does from here is done in the page that is already open. A reload would
  // lose the mark, so the assertions below cannot be passed by a refresh.
  await page.evaluate(() => {
    ;(window as unknown as { __liveTest?: string }).__liveTest = 'same page'
  })

  const visitorName = `Live Tester ${String(Date.now()).slice(-4)}`
  await guardRegisters(request, visitorName)

  // The dispatcher drains the queue once a second here, with room for a reconnect
  await expect(page.getByText(new RegExp(visitorName))).toBeVisible({ timeout: 25_000 })
  await expect(page.getByRole('button', { name: /^Mark \d+ as read$/ })).toBeVisible()
  // It arrived live, so the page must not be claiming otherwise
  await expect(page.getByText(/Real-time updates unavailable/)).toBeHidden()

  expect(await page.evaluate(() => (window as unknown as { __liveTest?: string }).__liveTest)).toBe('same page')
})
