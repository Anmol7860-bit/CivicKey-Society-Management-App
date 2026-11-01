import request from 'supertest'
import { and, eq, isNull } from 'drizzle-orm'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { auditLogs, permissions, societies, userPermissions, users } from '../../db/schema.js'
import { createUser, grantPermissions, PASSWORD, postLogin, TEST_SOCIETY_ID, signTestToken } from '../../test/helpers.js'
import { loadRole } from './permissions.js'

const OTHER_SOCIETY_ID = '33333333-3333-4333-8333-333333333333'
const app = createApp()

let auth: string
let actorId: string

async function tokenFor(user: { id: string; role: 'ADMIN' | 'RESIDENT' | 'GUARD' }) {
  return `Bearer ${await signTestToken({ userId: user.id, role: user.role, societyId: TEST_SOCIETY_ID })}`
}

const api = {
  get: (path: string, token = auth) => request(app).get(`/api/v1${path}`).set('Authorization', token),
  post: (path: string, body: object = {}, token = auth) => request(app).post(`/api/v1${path}`).set('Authorization', token).send(body),
  delete: (path: string, token = auth) => request(app).delete(`/api/v1${path}`).set('Authorization', token),
}

/** Codes of the user's active (unrevoked) grants */
async function activeGrants(userId: string) {
  const rows = await db
    .select({ code: permissions.code })
    .from(userPermissions)
    .innerJoin(permissions, eq(permissions.id, userPermissions.permissionId))
    .where(and(eq(userPermissions.userId, userId), isNull(userPermissions.revokedAt)))
  return rows.map((row) => row.code).sort()
}

/** The office records the document it saw, exactly as it does for a resident */
const ID = { idDocumentType: 'AADHAAR' as const, idNumber: '123456789012' }
const newAdmin = {
  name: 'Nisha Kulkarni',
  phone: '9700000001',
  email: 'nisha@civickey.local',
  permissions: ['SOCIETY_MANAGE', 'USER_MANAGE'],
  ...ID,
}

beforeEach(async () => {
  const actor = await createUser({ name: 'Anita Rao', phone: '9000000001', email: null, role: 'ADMIN' })
  actorId = actor.id
  await grantPermissions(actor.id, ['USER_MANAGE'])
  auth = await tokenFor(actor)
})

describe('POST /api/v1/societies/:societyId/admins', () => {
  it('creates the account, grants what was chosen and hands over a login code', async () => {
    const res = await api.post(`/societies/${TEST_SOCIETY_ID}/admins`, newAdmin)

    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      user: { name: 'Nisha Kulkarni', phone: '9700000001' },
      permissions: ['SOCIETY_MANAGE', 'USER_MANAGE'],
    })
    expect(res.body.data.loginCode.code).toMatch(/^[0-9]{4}$/)
    expect(res.headers['cache-control']).toBe('no-store')
    const created = res.body.data.user.id
    expect(await loadRole(db, created)).toBe('ADMIN')
    expect(await activeGrants(created)).toEqual(['SOCIETY_MANAGE', 'USER_MANAGE'])
    expect(await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'ADMIN_ACCOUNT_CREATED'))).toHaveLength(1)
  })

  it('records who granted each permission', async () => {
    const res = await api.post(`/societies/${TEST_SOCIETY_ID}/admins`, newAdmin)

    const rows = await db.select().from(userPermissions).where(eq(userPermissions.userId, res.body.data.user.id))
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.grantedBy === actorId && row.revokedAt === null)).toBe(true)
  })

  it('gives the permissions to the resident who already holds that number, keeping their password', async () => {
    const resident = await createUser({ resident: 'OWNER' })

    const res = await api.post(`/societies/${TEST_SOCIETY_ID}/admins`, { ...newAdmin, phone: resident.phone, email: undefined })

    expect(res.status).toBe(201)
    expect(res.body.data.user.id).toBe(resident.id)
    // An existing account keeps its own password, so there is no code to hand over
    expect(res.body.data.loginCode).toBeNull()
    expect((await postLogin(app, { phone: resident.phone, password: PASSWORD })).body.data.user).toMatchObject({
      role: 'ADMIN',
      permissions: expect.arrayContaining(['SOCIETY_MANAGE', 'USER_MANAGE', 'VISIT_VIEW_OWN']),
    })
  })

  it('refuses a permission that is not assignable, and an empty list', async () => {
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/admins`, { ...newAdmin, permissions: ['VISIT_REGISTER'] })).status).toBe(422)
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/admins`, { ...newAdmin, permissions: [] })).status).toBe(422)
    expect(await db.select().from(users).where(eq(users.phone, '9700000001'))).toHaveLength(0)
  })

  it('refuses another society, and a caller without USER_MANAGE', async () => {
    expect((await api.post(`/societies/${OTHER_SOCIETY_ID}/admins`, newAdmin)).status).toBe(403)

    const guard = await createUser({ phone: '9700000009', email: null, role: 'GUARD' })
    const res = await api.post(`/societies/${TEST_SOCIETY_ID}/admins`, newAdmin, await tokenFor(guard))
    expect(res.status).toBe(403)
    expect(await db.select().from(users).where(eq(users.phone, '9700000001'))).toHaveLength(0)
  })
})

describe('the document behind an Admin account', () => {
  it('stores the whole number encrypted and shows only its last 4', async () => {
    const res = await api.post(`/societies/${TEST_SOCIETY_ID}/admins`, newAdmin)

    expect(res.body.data.user).toMatchObject({ idDocumentType: 'AADHAAR', idDocumentLast4: '9012', idDocumentOnFile: true })
    const [row] = await db.select().from(users).where(eq(users.id, res.body.data.user.id))
    expect(row!.idDocumentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row!.idDocumentEncrypted).toBeTruthy()
    // The number itself is never in a response, and neither is anything it could be guessed from
    expect(JSON.stringify(res.body)).not.toContain('123456789012')
    expect(res.body.data.user).not.toHaveProperty('idDocumentHash')
    expect(res.body.data.user).not.toHaveProperty('idDocumentEncrypted')
  })

  it('will not create an Admin whose document has not been seen', async () => {
    const { idDocumentType: _type, idNumber: _number, ...withoutId } = newAdmin
    const res = await api.post(`/societies/${TEST_SOCIETY_ID}/admins`, withoutId)

    expect(res.status).toBe(422)
    expect(res.body.error.details.fields.map((issue: { field: string }) => issue.field).sort()).toEqual(['idDocumentType', 'idNumber'])
    expect(await db.select().from(users).where(eq(users.phone, '9700000001'))).toHaveLength(0)
  })

  it('records the document for the resident it promotes', async () => {
    const resident = await createUser({ resident: 'OWNER' })

    await api.post(`/societies/${TEST_SOCIETY_ID}/admins`, { ...newAdmin, phone: resident.phone, email: undefined })

    const [row] = await db.select().from(users).where(eq(users.id, resident.id))
    expect(row).toMatchObject({ idDocumentType: 'AADHAAR', idDocumentLast4: '9012' })
  })

  it('reads the number back once, with a reason, and writes that down', async () => {
    const created = (await api.post(`/societies/${TEST_SOCIETY_ID}/admins`, newAdmin)).body.data.user.id

    const res = await api.post(`/users/${created}/id-document`, { reason: 'Society audit of committee records' })

    expect(res.body.data).toEqual({ idDocumentType: 'AADHAAR', idNumber: '123456789012' })
    expect(res.headers['cache-control']).toBe('no-store')
    const [event] = await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'USER_ID_REVEALED'))
    expect(event!.metadata).toMatchObject({ userId: created, reason: 'Society audit of committee records' })
    // The reason is not optional, and the number is never read without one
    expect((await api.post(`/users/${created}/id-document`, { reason: 'no' })).status).toBe(422)
  })

  it('has nothing to read back for an Admin from before the document was recorded', async () => {
    const older = await createUser({ phone: '9700000004', email: null, role: 'ADMIN' })

    const res = await api.post(`/users/${older.id}/id-document`, { reason: 'Society audit of committee records' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_STATE')
  })
})

describe('GET /api/v1/societies/:societyId/admins', () => {
  it('lists the society Admins with what each one holds', async () => {
    await api.post(`/societies/${TEST_SOCIETY_ID}/admins`, newAdmin)

    const res = await api.get(`/societies/${TEST_SOCIETY_ID}/admins`)

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Anita Rao', resident: false, idDocumentOnFile: false, permissions: ['USER_MANAGE'] }),
        expect.objectContaining({
          name: 'Nisha Kulkarni',
          resident: false,
          idDocumentLast4: '9012',
          idDocumentOnFile: true,
          permissions: ['SOCIETY_MANAGE', 'USER_MANAGE'],
        }),
      ]),
    )
  })
})

describe('committee permissions', () => {
  it('gives a resident the chosen committee permissions and takes them back', async () => {
    const resident = await createUser({ resident: 'OWNER' })

    const set = await api.post(`/users/${resident.id}/committee-permissions`, { permissions: ['REPORT_VIEW', 'BILLING_RATE_SET'] })
    expect(set.status).toBe(200)
    expect(set.body.data).toEqual({ userId: resident.id, permissions: ['BILLING_RATE_SET', 'REPORT_VIEW'] })
    expect(await loadRole(db, resident.id)).toBe('ADMIN')

    const removed = await api.delete(`/users/${resident.id}/committee-permissions`)
    expect(removed.status).toBe(200)
    expect(removed.body.data.permissions).toEqual([])
    // They keep their flat, so they are a Resident again
    expect(await loadRole(db, resident.id)).toBe('RESIDENT')
  })

  it('refuses a General Admin permission through the committee route', async () => {
    const resident = await createUser({ resident: 'OWNER' })

    const res = await api.post(`/users/${resident.id}/committee-permissions`, { permissions: ['USER_MANAGE'] })

    expect(res.status).toBe(422)
    expect(await activeGrants(resident.id)).toEqual([])
  })

  it('refuses someone who is not a resident of this society', async () => {
    const staffAdmin = await createUser({ phone: '9700000002', email: null, role: 'ADMIN' })
    expect((await api.post(`/users/${staffAdmin.id}/committee-permissions`, { permissions: ['REPORT_VIEW'] })).status).toBe(409)

    await db.insert(societies).values({ id: OTHER_SOCIETY_ID, name: 'Other' }).onConflictDoNothing()
    const outsider = await createUser({ phone: '9700000003', email: null, societyId: OTHER_SOCIETY_ID })
    const res = await api.post(`/users/${outsider.id}/committee-permissions`, { permissions: ['REPORT_VIEW'] })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('CROSS_SOCIETY_ACCESS')
  })

  it('returns 404 for an unknown user', async () => {
    expect((await api.post('/users/44444444-4444-4444-8444-444444444444/committee-permissions', { permissions: ['REPORT_VIEW'] })).status).toBe(404)
  })
})
