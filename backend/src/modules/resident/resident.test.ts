import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { auditLogs, flatResidents, users } from '../../db/schema.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { addResident, createFlat, createUser, grantPermissions, TEST_SOCIETY_ID } from '../../test/helpers.js'
import { assertFlatAccess } from '../access/scope.js'
import { signAccessToken } from '../auth/tokens.js'

const OTHER_SOCIETY_ID = '33333333-3333-4333-8333-333333333333'
const MISSING_ID = '44444444-4444-4444-8444-444444444444'
const app = createApp()

let auth: string
let flatId: string

async function tokenFor(user: { id: string; role: 'ADMIN' | 'RESIDENT' | 'GUARD' }) {
  return `Bearer ${await signAccessToken({ userId: user.id, sessionId: 's1', role: user.role, societyId: TEST_SOCIETY_ID })}`
}

const api = {
  get: (path: string, token = auth) => request(app).get(`/api/v1${path}`).set('Authorization', token),
  post: (path: string, body: object = {}, token = auth) => request(app).post(`/api/v1${path}`).set('Authorization', token).send(body),
  put: (path: string, body: object, token = auth) => request(app).put(`/api/v1${path}`).set('Authorization', token).send(body),
}

const owner = { name: 'Riya Sharma', phone: '9811111111', residentType: 'OWNER' as const }
const tenant = { name: 'Arjun Nair', phone: '9822222222', residentType: 'TENANT' as const, startDate: '2025-01-01', endDate: '2099-12-31' }

/** The resident's own view of a flat, as a feature route would see it. */
function ctxFor(userId: string): AuthContext {
  return { userId, sessionId: 's1', role: 'RESIDENT', societyId: TEST_SOCIETY_ID, permissions: ['VISIT_VIEW_OWN'] }
}
const canAccess = (userId: string, id = flatId, write = false) => assertFlatAccess(ctxFor(userId), id, { write })

function register(body: object, id = flatId) {
  return api.post(`/flats/${id}/residents`, body)
}

beforeEach(async () => {
  const admin = await createUser({ phone: '9000000001', email: null, role: 'ADMIN' })
  await grantPermissions(admin.id, ['USER_MANAGE', 'SOCIETY_MANAGE'])
  auth = await tokenFor(admin)
  flatId = (await createFlat()).id
})

describe('authorization', () => {
  it('requires a token and USER_MANAGE', async () => {
    const resident = await createUser({ phone: '9000000002', email: null, resident: 'OWNER' })

    expect((await request(app).get(`/api/v1/flats/${flatId}/residents`)).status).toBe(401)
    const res = await api.get(`/flats/${flatId}/residents`, await tokenFor(resident))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('PERMISSION_DENIED')
  })

  it('refuses another society and unknown ids', async () => {
    const other = await createFlat(OTHER_SOCIETY_ID, '501')

    expect((await register(owner, other.id)).body.error.code).toBe('CROSS_SOCIETY_ACCESS')
    expect((await api.get(`/societies/${OTHER_SOCIETY_ID}/residents`)).status).toBe(403)
    expect((await register(owner, MISSING_ID)).status).toBe(404)
    expect((await api.post(`/residents/${MISSING_ID}/verify`)).status).toBe(404)
    expect((await api.post('/residents/nope/verify')).status).toBe(404)
  })
})

describe('owner registration', () => {
  it('creates the account, grants nothing until verified, then grants access', async () => {
    const res = await register({ ...owner, email: 'Riya@Example.com', idDocumentType: 'AADHAAR', idDocumentLast4: '4321', proofReference: 'Deed/2024/88' })

    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      verificationStatus: 'PENDING',
      residentType: 'OWNER',
      accessLevel: 'FULL',
      verifiedAt: null,
      idDocumentLast4: '4321',
      user: { name: 'Riya Sharma', phone: '9811111111', email: 'riya@example.com' },
    })
    const userId = res.body.data.user.id

    // A registered, mobile-verified person with an account still has no access to the flat
    await expect(canAccess(userId)).rejects.toMatchObject({ code: 'NOT_YOUR_FLAT' })

    const verified = await api.post(`/residents/${res.body.data.id}/verify`)
    expect(verified.status).toBe(200)
    expect(verified.body.data).toMatchObject({ verificationStatus: 'VERIFIED' })
    expect(verified.body.data.verifiedAt).not.toBeNull()
    await expect(canAccess(userId)).resolves.toBeUndefined()

    const events = await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'RESIDENT_VERIFIED'))
    expect(events).toHaveLength(1)
  })

  it('links an existing account instead of creating a second one', async () => {
    const first = await register(owner)
    const second = await register({ ...owner, name: 'Someone Else' }, (await createFlat(TEST_SOCIETY_ID, '202')).id)

    expect(second.status).toBe(201)
    expect(second.body.data.user.id).toBe(first.body.data.user.id)
    // The existing account keeps its own name
    expect(second.body.data.user.name).toBe('Riya Sharma')
    expect(await db.select().from(users).where(eq(users.phone, owner.phone))).toHaveLength(1)
  })

  it('refuses a second overlapping assignment for the same person on the same flat', async () => {
    await register(owner)

    const again = await register(owner)

    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('ALREADY_EXISTS')
  })

  it('refuses an inactive flat', async () => {
    await api.put(`/flats/${flatId}`, { status: 'INACTIVE' })

    const res = await register(owner)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_STATE')
  })
})

describe('tenant registration', () => {
  it('needs both a start and an end date', async () => {
    const { name, phone } = tenant

    const noEnd = await register({ name, phone, residentType: 'TENANT', startDate: '2025-01-01' })
    expect(noEnd.status).toBe(422)
    expect(noEnd.body.error.details.fields).toEqual([{ field: 'endDate', message: 'A tenancy must have an end date' }])

    const noStart = await register({ name, phone, residentType: 'TENANT', endDate: '2099-12-31' })
    expect(noStart.body.error.details.fields).toEqual([{ field: 'startDate', message: 'A tenancy must have a start date' }])
  })

  it('keeps access only for the tenancy period and keeps the history after it ends', async () => {
    const former = await createUser({ phone: '9833333333', email: null })
    // An ended tenancy: verified in its day, over now
    await addResident(flatId, former.id, { residentType: 'TENANT', startDate: '2020-01-01', endDate: '2021-01-01' })

    await expect(canAccess(former.id)).rejects.toMatchObject({ code: 'NOT_YOUR_FLAT' })

    // Registering again does not restore anything: the new assignment waits for approval
    const again = await register({ ...tenant, phone: '9833333333' })
    expect(again.status).toBe(201)
    expect(again.body.data.verificationStatus).toBe('PENDING')
    await expect(canAccess(former.id)).rejects.toMatchObject({ code: 'NOT_YOUR_FLAT' })

    await api.post(`/residents/${again.body.data.id}/verify`)
    await expect(canAccess(former.id)).resolves.toBeUndefined()

    const list = await api.get(`/flats/${flatId}/residents`)
    expect(list.body.data).toHaveLength(2)
    expect(list.body.data.map((row: { active: boolean }) => row.active)).toEqual([true, false])
  })

  it('extends a live tenancy but never one that has already ended', async () => {
    const res = await register(tenant)
    await api.post(`/residents/${res.body.data.id}/verify`)

    const extended = await api.put(`/residents/${res.body.data.id}`, { endDate: '2100-06-30' })
    expect(extended.body.data.endDate).toBe('2100-06-30')

    const ended = await createUser({ phone: '9844444444', email: null })
    const old = await addResident(flatId, ended.id, { residentType: 'TENANT', startDate: '2020-01-01', endDate: '2021-01-01' })
    const refused = await api.put(`/residents/${old.id}`, { endDate: '2099-01-01' })
    expect(refused.status).toBe(400)
    expect(refused.body.error.message).toMatch(/register the resident again/)
  })

  it('closes access when the Admin ends the tenancy', async () => {
    const res = await register({ ...tenant, startDate: '2024-01-01' })
    await api.post(`/residents/${res.body.data.id}/verify`)
    const userId = res.body.data.user.id
    await expect(canAccess(userId)).resolves.toBeUndefined()

    await api.put(`/residents/${res.body.data.id}`, { endDate: '2024-06-30' })

    await expect(canAccess(userId)).rejects.toMatchObject({ code: 'NOT_YOUR_FLAT' })
    expect((await api.get(`/flats/${flatId}/residents`)).body.data[0]).toMatchObject({ active: false, eligible: false })
  })
})

describe('verification', () => {
  it('rejects a registration with a reason, and it cannot then be verified', async () => {
    const res = await register(owner)

    const rejected = await api.post(`/residents/${res.body.data.id}/reject`, { reason: 'Ownership proof missing' })

    expect(rejected.body.data).toMatchObject({ verificationStatus: 'REJECTED', rejectedReason: 'Ownership proof missing' })
    await expect(canAccess(res.body.data.user.id)).rejects.toMatchObject({ code: 'NOT_YOUR_FLAT' })
    expect((await api.post(`/residents/${res.body.data.id}/verify`)).status).toBe(400)
    expect((await api.post(`/residents/${res.body.data.id}/reject`, { reason: 'Again' })).status).toBe(400)
  })

  it('lists the society directory and filters it by status, type and access', async () => {
    const pending = await register(owner)
    const live = await register(tenant)
    await api.post(`/residents/${live.body.data.id}/verify`)
    const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((row) => row.id)

    const all = await api.get(`/societies/${TEST_SOCIETY_ID}/residents`)
    expect(all.body.data).toHaveLength(2)
    expect(all.body.data[0]).toMatchObject({ flat: { number: '101' }, block: { name: 'A-101' } })

    // The approval queue is the directory filtered by status
    expect(ids(await api.get(`/societies/${TEST_SOCIETY_ID}/residents?status=PENDING`))).toEqual([pending.body.data.id])
    expect(ids(await api.get(`/societies/${TEST_SOCIETY_ID}/residents?residentType=TENANT&active=true`))).toEqual([
      live.body.data.id,
    ])
    expect(ids(await api.get(`/societies/${TEST_SOCIETY_ID}/residents?active=false`))).toEqual([pending.body.data.id])
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/residents?status=NOPE`)).status).toBe(422)
  })

  it('gives a VIEW_ONLY co-owner the flat without the right to act on it', async () => {
    const first = await register(owner)
    await api.post(`/residents/${first.body.data.id}/verify`)
    const second = await register({ name: 'Priya Sharma', phone: '9855555555', residentType: 'OWNER', accessLevel: 'VIEW_ONLY' })
    await api.post(`/residents/${second.body.data.id}/verify`)

    const coOwner = second.body.data.user.id
    await expect(canAccess(coOwner)).resolves.toBeUndefined()
    await expect(canAccess(coOwner, flatId, true)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })

    // Visitor approvals route to eligible residents only, so a VIEW_ONLY co-owner is left out
    const list = await api.get(`/flats/${flatId}/residents`)
    expect(list.body.data.map((row: { accessLevel: string; eligible: boolean }) => [row.accessLevel, row.eligible])).toEqual([
      ['VIEW_ONLY', false],
      ['FULL', true],
    ])
  })

  it('raises a VIEW_ONLY resident to FULL at verification', async () => {
    const res = await register({ ...owner, accessLevel: 'VIEW_ONLY' })

    const verified = await api.post(`/residents/${res.body.data.id}/verify`, { accessLevel: 'FULL' })

    expect(verified.body.data.accessLevel).toBe('FULL')
    await expect(canAccess(res.body.data.user.id, flatId, true)).resolves.toBeUndefined()
  })
})

describe('government ID', () => {
  it('keeps the type, a keyed hash and the last 4 digits, never the number', async () => {
    const res = await register({ ...owner, idDocumentType: 'AADHAAR', idNumber: '123456789012' })

    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ idDocumentType: 'AADHAAR', idDocumentLast4: '9012', idDocumentOnFile: true })
    expect(res.body.data).not.toHaveProperty('idDocumentHash')
    expect(JSON.stringify(res.body)).not.toContain('123456789012')

    const [row] = await db.select().from(flatResidents).where(eq(flatResidents.id, res.body.data.id))
    expect(row!.idDocumentHash).toMatch(/^[0-9a-f]{64}$/)
    const list = await api.get(`/flats/${flatId}/residents`)
    expect(list.body.data[0]).toMatchObject({ idDocumentOnFile: true })
    expect(list.body.data[0]).not.toHaveProperty('idDocumentHash')
  })

  it('refuses a mismatched last 4 and an ID number with no document type', async () => {
    const mismatch = await register({ ...owner, idDocumentType: 'PAN', idNumber: 'ABCDE1234F', idDocumentLast4: '9999' })
    expect(mismatch.status).toBe(422)
    expect((await register({ ...owner, idNumber: 'ABCDE1234F' })).status).toBe(422)
  })
})

describe('multiple residents per flat', () => {
  it('counts tenants against the sharing cap and lets owners in regardless', async () => {
    await api.put(`/flats/${flatId}`, { sharingAllowed: true, maxOccupants: 2 })
    const ids: string[] = []
    for (const phone of ['9866666661', '9866666662', '9866666663']) {
      const res = await register({ ...tenant, phone, name: `Flatmate ${phone.slice(-1)}` })
      ids.push(res.body.data.id)
    }

    expect((await api.post(`/residents/${ids[0]}/verify`)).status).toBe(200)
    expect((await api.post(`/residents/${ids[1]}/verify`)).status).toBe(200)
    const full = await api.post(`/residents/${ids[2]}/verify`)
    expect(full.status).toBe(400)
    expect(full.body.error.message).toMatch(/at most 2 tenants/)

    // The owner never takes a tenant slot
    const landlord = await register(owner)
    expect((await api.post(`/residents/${landlord.body.data.id}/verify`)).status).toBe(200)
    const occupancy = await api.get(`/societies/${TEST_SOCIETY_ID}/occupancy`)
    const flat = occupancy.body.data.blocks[0].floors[0].flats[0]
    expect(flat).toMatchObject({ owners: 1, tenants: 2, occupants: 3, slotsLeft: 0, ownership: 'OWNED', occupancy: 'FULL' })
  })

  it('allows one tenant on a flat that does not allow sharing', async () => {
    const first = await register(tenant)
    await api.post(`/residents/${first.body.data.id}/verify`)
    const second = await register({ ...tenant, phone: '9877777777', name: 'Second Tenant' })

    const refused = await api.post(`/residents/${second.body.data.id}/verify`)

    expect(refused.status).toBe(400)
    expect(refused.body.error.message).toMatch(/does not allow sharing/)
  })
})
