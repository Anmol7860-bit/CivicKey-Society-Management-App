import { eq } from 'drizzle-orm'
import request from 'supertest'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { auditLogs, authSessions, passwordSetupCodes, users } from '../../db/schema.js'
import { createFlat, createUser, grantPermissions, PASSWORD, postLogin, TEST_SOCIETY_ID, type App, signTestToken } from '../../test/helpers.js'

const OTHER_SOCIETY_ID = '33333333-3333-4333-8333-333333333333'
const NEW_PASSWORD = 'Monsoon2026rain'

// A fresh app per test: the rate limiters keep their counts in memory
let app: App
let auth: string
let flatId: string

async function adminToken(societyId = TEST_SOCIETY_ID, phone = '9000000001') {
  const admin = await createUser({ phone, email: null, role: 'ADMIN', societyId })
  await grantPermissions(admin.id, ['USER_MANAGE'])
  return `Bearer ${await signTestToken({ userId: admin.id, role: 'ADMIN', societyId })}`
}

const api = {
  post: (path: string, body: object = {}, token?: string) => {
    const call = request(app).post(`/api/v1${path}`)
    return (token ? call.set('Authorization', token) : call).send(body)
  },
}

/** Registers a resident and returns the code the Admin is handed. */
async function registerResident(phone = '9811111111') {
  const res = await api.post(`/flats/${flatId}/residents`, { name: 'Riya Sharma', phone, residentType: 'OWNER', idDocumentType: 'AADHAAR', idNumber: '123456789012' }, auth)
  expect(res.status).toBe(201)
  return res.body.data
}

beforeEach(async () => {
  app = createApp()
  auth = await adminToken()
  flatId = (await createFlat()).id
})

describe('a resident the office registered', () => {
  it('comes with a one-time code, and sets a password with it', async () => {
    const { loginCode, user } = await registerResident()

    expect(loginCode.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(new Date(loginCode.expiresAt).getTime()).toBeGreaterThan(Date.now())
    // Until the code is spent, nothing the Admin typed is a password for that account
    expect((await postLogin(app, { phone: '9811111111', password: PASSWORD })).status).toBe(401)

    const set = await api.post('/auth/set-password', { code: loginCode.code, password: NEW_PASSWORD })
    expect(set.status).toBe(200)
    expect(set.body.data).toEqual({ passwordSet: true })

    const login = await postLogin(app, { phone: '9811111111', password: NEW_PASSWORD })
    expect(login.status).toBe(200)
    expect(login.body.data.user.id).toBe(user.id)
  })

  it('never stores the code itself, and spends it only once', async () => {
    const { loginCode } = await registerResident()

    const [stored] = await db.select().from(passwordSetupCodes)
    expect(stored!.codeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(stored)).not.toContain(loginCode.code.replace(/-/g, ''))

    expect((await api.post('/auth/set-password', { code: loginCode.code, password: NEW_PASSWORD })).status).toBe(200)
    const again = await api.post('/auth/set-password', { code: loginCode.code, password: 'Another2026one' })
    expect(again.status).toBe(400)
    expect(again.body.error.code).toBe('INVALID_CODE')
  })

  it('accepts the code with spaces, dashes or lower case', async () => {
    const { loginCode } = await registerResident()
    const typed = ` ${loginCode.code.replace(/-/g, ' ').toLowerCase()} `

    expect((await api.post('/auth/set-password', { code: typed, password: NEW_PASSWORD })).status).toBe(200)
  })

  it('leaves an existing account its own password', async () => {
    await createUser({ phone: '9833333333', email: null })
    const res = await api.post(`/flats/${flatId}/residents`, { name: 'Riya Sharma', phone: '9833333333', residentType: 'OWNER', idDocumentType: 'AADHAAR', idNumber: '123456789012' }, auth)

    expect(res.status).toBe(201)
    expect(res.body.data.loginCode).toBeNull()
    expect((await postLogin(app, { phone: '9833333333', password: PASSWORD })).status).toBe(200)
  })
})

describe('POST /api/v1/users/:userId/login-code', () => {
  it('reissues a code and retires the one before it', async () => {
    const { user, loginCode } = await registerResident()

    const res = await api.post(`/users/${user.id}/login-code`, {}, auth)
    expect(res.status).toBe(200)
    expect(res.body.data.user).toEqual({ id: user.id, name: 'Riya Sharma' })
    expect(res.headers['cache-control']).toBe('no-store')

    expect((await api.post('/auth/set-password', { code: loginCode.code, password: NEW_PASSWORD })).status).toBe(400)
    expect((await api.post('/auth/set-password', { code: res.body.data.code, password: NEW_PASSWORD })).status).toBe(200)
  })

  it('needs USER_MANAGE, the same society, and a real account', async () => {
    const { user } = await registerResident()
    const resident = await createUser({ phone: '9000000009', email: null })

    expect((await api.post(`/users/${user.id}/login-code`)).status).toBe(401)
    const asResident = `Bearer ${await signTestToken({ userId: resident.id, role: 'RESIDENT', societyId: TEST_SOCIETY_ID })}`
    expect((await api.post(`/users/${user.id}/login-code`, {}, asResident)).status).toBe(403)

    await createFlat(OTHER_SOCIETY_ID, '501')
    const otherAdmin = await adminToken(OTHER_SOCIETY_ID, '9000000002')
    expect((await api.post(`/users/${user.id}/login-code`, {}, otherAdmin)).body.error.code).toBe('CROSS_SOCIETY_ACCESS')
    expect((await api.post('/users/not-a-uuid/login-code', {}, auth)).status).toBe(404)
  })

  it('refuses a deactivated account', async () => {
    const { user } = await registerResident()
    await db.update(users).set({ isActive: false }).where(eq(users.id, user.id))

    const res = await api.post(`/users/${user.id}/login-code`, {}, auth)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_STATE')
  })
})

describe('setting a password', () => {
  it('insists on a password worth having', async () => {
    const { loginCode } = await registerResident()

    for (const password of ['short1', 'allletterspassword', '1234567890123']) {
      const res = await api.post('/auth/set-password', { code: loginCode.code, password })
      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('signs out every session that used the old password', async () => {
    await createUser({ phone: '9844444444', email: null })
    const login = await postLogin(app, { phone: '9844444444', password: PASSWORD })
    const [target] = await db.select().from(users).where(eq(users.phone, '9844444444'))
    const code = (await api.post(`/users/${target!.id}/login-code`, {}, auth)).body.data.code

    expect((await api.post('/auth/set-password', { code, password: NEW_PASSWORD })).status).toBe(200)

    const [session] = await db.select().from(authSessions).where(eq(authSessions.userId, target!.id))
    expect(session!.revokedAt).not.toBeNull()
    expect(session!.revokedReason).toBe('PASSWORD_CHANGED')
    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', login.headers['set-cookie']!)
    expect(refreshed.status).toBe(401)
  })

  it('refuses an expired code', async () => {
    const { loginCode } = await registerResident()
    await db.update(passwordSetupCodes).set({ expiresAt: new Date(Date.now() - 1000) })

    expect((await api.post('/auth/set-password', { code: loginCode.code, password: NEW_PASSWORD })).status).toBe(400)
  })
})

describe('POST /api/v1/auth/forgot-password', () => {
  it('answers the same way whether or not the number is registered, and tells the office', async () => {
    await createUser({ phone: '9855555555', email: null })

    const known = await api.post('/auth/forgot-password', { phone: '9855555555' })
    const unknown = await api.post('/auth/forgot-password', { phone: '9866666666' })

    expect(known.status).toBe(200)
    expect(known.body).toEqual(unknown.body)
    expect(known.body.data).toEqual({ requested: true })

    const events = await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'PASSWORD_RESET_REQUESTED'))
    expect(events).toHaveLength(2)
    // The log is the office's queue, so it must not print the whole number
    expect(JSON.stringify(events)).not.toContain('9855555555')
  })

  it('rejects anything that is not a mobile number', async () => {
    expect((await api.post('/auth/forgot-password', { phone: '12345' })).status).toBe(422)
  })
})
