import request from 'supertest'
import { eq, isNull } from 'drizzle-orm'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { asc } from 'drizzle-orm'
import { auditLogs, authSessions, gates, guardGateAssignments, societies, staff, users } from '../../db/schema.js'
import { loadRole } from '../access/permissions.js'
import { createFlat, createPhoto, createUser, grantPermissions, TEST_SOCIETY_ID, signTestToken } from '../../test/helpers.js'

const OTHER_SOCIETY_ID = '33333333-3333-4333-8333-333333333333'
const app = createApp()

let auth: string
let gateId: string
let flatId: string
let photoId: string

async function tokenFor(user: { id: string; role: 'ADMIN' | 'RESIDENT' | 'GUARD' }) {
  return `Bearer ${await signTestToken({ userId: user.id, role: user.role, societyId: TEST_SOCIETY_ID })}`
}

const api = {
  get: (path: string, token = auth) => request(app).get(`/api/v1${path}`).set('Authorization', token),
  post: (path: string, body: object = {}, token = auth) =>
    request(app).post(`/api/v1${path}`).set('Authorization', token).send(body),
  put: (path: string, body: object, token = auth) => request(app).put(`/api/v1${path}`).set('Authorization', token).send(body),
}

const guard = () => ({
  kind: 'GUARD' as const,
  name: 'Mahesh Patil',
  phone: '9811111111',
  agency: 'SafeGuard',
  gateId,
  shift: 'MORNING' as const,
  photoReference: photoId,
})
const help = () => ({
  kind: 'DAILY_HELP' as const,
  name: 'Sunita Devi',
  phone: '9822222222',
  workType: 'Maid',
  workingDays: ['MON', 'WED', 'TUE'] as const,
  flatsServed: [{ flatId, timeWindow: '7-9 am' }],
  passValidFrom: '2026-01-01',
  photoReference: photoId,
})

const register = (body: object) => api.post(`/societies/${TEST_SOCIETY_ID}/staff`, body)

beforeEach(async () => {
  const admin = await createUser({
    phone: '9000000001',
    email: null,
    role: 'ADMIN',
  })
  await grantPermissions(admin.id, ['GUARD_MANAGE', 'STAFF_MANAGE', 'SOCIETY_MANAGE'])
  auth = await tokenFor(admin)
  const [gate] = await db.insert(gates).values({ societyId: TEST_SOCIETY_ID, code: 'MAIN', name: 'Main gate' }).returning()
  gateId = gate!.id
  flatId = (await createFlat()).id
  photoId = await createPhoto()
})

describe('authorization', () => {
  it('needs a token and one of the staff permissions', async () => {
    const resident = await createUser({ phone: '9000000003', email: null })

    expect((await request(app).get(`/api/v1/societies/${TEST_SOCIETY_ID}/staff`)).status).toBe(401)
    const res = await api.get(`/societies/${TEST_SOCIETY_ID}/staff`, await tokenFor(resident))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('PERMISSION_DENIED')
  })

  it('keeps guards to Manage guards and everyone else to Register staff', async () => {
    const guardsOnly = await createUser({
      phone: '9000000004',
      email: null,
      role: 'ADMIN',
    })
    await grantPermissions(guardsOnly.id, ['GUARD_MANAGE'])
    const token = await tokenFor(guardsOnly)
    await register(guard())
    await register(help())

    // Registering daily help needs Register staff, which this Admin does not hold
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/staff`, help(), token)).status).toBe(403)
    // And the list shows only the kinds they may manage
    const list = await api.get(`/societies/${TEST_SOCIETY_ID}/staff`, token)
    expect(list.body.data.staff.map((row: { kind: string }) => row.kind)).toEqual(['GUARD'])
  })

  it('refuses another society and an unknown id', async () => {
    await db.insert(societies).values({ id: OTHER_SOCIETY_ID, name: 'Other Society' })

    expect((await api.get(`/societies/${OTHER_SOCIETY_ID}/staff`)).status).toBe(403)
    expect((await api.put(`/staff/${OTHER_SOCIETY_ID}`, { name: 'Nobody' })).status).toBe(404)
  })
})

describe('guards', () => {
  it('registers one on a gate and a shift, and issues a pass code', async () => {
    const res = await register(guard())

    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      kind: 'GUARD',
      shift: 'MORNING',
      status: 'ACTIVE',
      policeVerification: 'NOT_STARTED',
    })
    expect(res.body.data.passCode).toMatch(/^CK-[0-9A-Z]{8}$/)

    const list = await api.get(`/societies/${TEST_SOCIETY_ID}/staff?kind=GUARD`)
    expect(list.body.data.staff[0]).toMatchObject({
      name: 'Mahesh Patil',
      gateName: 'Main gate',
    })
  })

  it('needs a gate and a shift, and the gate must be an active one of this society', async () => {
    const { gateId: _gate, ...withoutGate } = guard()
    expect((await register(withoutGate)).status).toBe(422)

    const [elsewhere] = await db
      .insert(gates)
      .values({
        societyId: TEST_SOCIETY_ID,
        code: 'SERVICE',
        name: 'Service gate',
        status: 'INACTIVE',
      })
      .returning()
    const refused = await register({ ...guard(), gateId: elsewhere!.id })
    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe('INVALID_STATE')
  })

  it('refuses a second staff member with the same mobile number', async () => {
    await register(guard())

    const again = await register({ ...guard(), name: 'Someone Else' })

    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('ALREADY_EXISTS')
  })
})

describe('daily help', () => {
  it('serves flats of this society, with the days stored in week order', async () => {
    const res = await register(help())

    expect(res.status).toBe(201)
    expect(res.body.data.workingDays).toBe('MON,TUE,WED')
    const list = await api.get(`/societies/${TEST_SOCIETY_ID}/staff?kind=DAILY_HELP`)
    expect(list.body.data.staff[0].flatsServed).toEqual([expect.objectContaining({ flatId, timeWindow: '7-9 am' })])
  })

  it('needs at least one flat, and never one from another society', async () => {
    const { flatsServed: _flats, ...withoutFlats } = help()
    expect((await register(withoutFlats)).status).toBe(422)

    const elsewhere = await createFlat(OTHER_SOCIETY_ID, '501')
    const refused = await register({
      ...help(),
      flatsServed: [{ flatId: elsewhere.id }],
    })
    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe('INVALID_STATE')
  })

  it('replaces the flats served on an edit and will not empty the list', async () => {
    const created = await register(help())
    const second = await createFlat(TEST_SOCIETY_ID, '202')

    const moved = await api.put(`/staff/${created.body.data.id}`, {
      flatsServed: [{ flatId: second.id, timeWindow: '10-11 am' }],
    })
    expect(moved.status).toBe(200)
    const list = await api.get(`/societies/${TEST_SOCIETY_ID}/staff?kind=DAILY_HELP`)
    expect(list.body.data.staff[0].flatsServed).toEqual([expect.objectContaining({ flatId: second.id })])

    expect((await api.put(`/staff/${created.body.data.id}`, { flatsServed: [] })).status).toBe(400)
  })
})

describe('the record', () => {
  it('keeps the ID as a hash and the last 4, never the number', async () => {
    const res = await register({
      ...help(),
      idDocumentType: 'AADHAAR',
      idNumber: '123456789012',
    })

    expect(res.body.data.idDocumentLast4).toBe('9012')
    expect(res.body.data.idDocumentOnFile).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain('123456789012')
    const [row] = await db.select().from(staff).where(eq(staff.id, res.body.data.id))
    expect(row!.idDocumentHash).toMatch(/^[0-9a-f]{64}$/)
    // The number is kept, but as ciphertext: the column never holds it in the clear
    expect(row!.idDocumentEncrypted).not.toContain('123456789012')
    expect(Buffer.from(row!.idDocumentEncrypted!, 'base64').length).toBeGreaterThan(28)
  })

  it('gives the captured number back only to an audited read, with a reason', async () => {
    const created = await register({ ...guard(), idDocumentType: 'AADHAAR', idNumber: '123456789012' })

    expect((await api.post(`/staff/${created.body.data.id}/id-document`, {})).status).toBe(422)

    const read = await api.post(`/staff/${created.body.data.id}/id-document`, { reason: 'Police verification visit' })
    expect(read.status).toBe(200)
    expect(read.body.data).toEqual({ idDocumentType: 'AADHAAR', idNumber: '123456789012' })

    const [logged] = await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'STAFF_ID_REVEALED'))
    expect(logged!.metadata).toMatchObject({ reason: 'Police verification visit' })
    expect(JSON.stringify(logged!.metadata)).not.toContain('123456789012')

    const without = await register({ ...guard(), phone: '9833333333' })
    expect((await api.post(`/staff/${without.body.data.id}/id-document`, { reason: 'Checking the file' })).status).toBe(400)
  })

  it('needs a reason to deactivate, and searches by name or number', async () => {
    const created = await register(guard())

    expect((await api.put(`/staff/${created.body.data.id}`, { status: 'INACTIVE' })).status).toBe(422)
    expect(
      (
        await api.put(`/staff/${created.body.data.id}`, {
          status: 'INACTIVE',
          reason: 'Left the agency',
        })
      ).status,
    ).toBe(200)

    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff?search=mahesh`)).body.data.staff).toHaveLength(1)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff?search=98111`)).body.data.staff).toHaveLength(1)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff?search=nobody`)).body.data.staff).toHaveLength(0)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff?status=ACTIVE`)).body.data.staff).toHaveLength(0)
  })

  it('issues a fresh pass code and refuses one for an inactive staff member', async () => {
    const created = await register(guard())

    const reissued = await api.post(`/staff/${created.body.data.id}/pass`)
    expect(reissued.status).toBe(200)
    expect(reissued.body.data.passCode).not.toBe(created.body.data.passCode)

    await api.put(`/staff/${created.body.data.id}`, {
      status: 'INACTIVE',
      reason: 'Left the agency',
    })
    expect((await api.post(`/staff/${created.body.data.id}/pass`)).status).toBe(400)
  })
})

describe('the account a guard signs in with', () => {
  const registerGuard = async (overrides: object = {}) => (await register({ ...guard(), ...overrides })).body.data

  it('creates the account, posts it to the gate and hands over a one-time code', async () => {
    const member = await registerGuard()

    const res = await api.post(`/staff/${member.id}/account`)
    expect(res.status).toBe(201)
    expect(res.body.data.account).toMatchObject({ name: 'Mahesh Patil', isActive: true })
    expect(res.body.data.loginCode.code).toMatch(/^[A-Z0-9-]{12,}$/)

    const [row] = await db.select().from(staff).where(eq(staff.id, member.id))
    const [account] = await db.select().from(users).where(eq(users.id, row!.userId!))
    expect(account!.phone).toBe('9811111111')
    expect(account!.societyId).toBe(TEST_SOCIETY_ID)
    expect(await loadRole(db, account!.id)).toBe('GUARD')

    // The posting is what a gate operation is checked against, so linking writes one
    const postings = await db.select().from(guardGateAssignments).where(eq(guardGateAssignments.guardUserId, account!.id))
    expect(postings).toHaveLength(1)
    expect(postings[0]).toMatchObject({ gateId, endAt: null })
    expect(await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'STAFF_ACCOUNT_LINKED'))).toHaveLength(1)

    // Asking twice changes nothing and says so
    expect((await api.post(`/staff/${member.id}/account`)).status).toBe(409)
  })

  it('refuses daily help and an account that belongs to somebody else', async () => {
    const helper = (await register(help())).body.data
    const refused = await api.post(`/staff/${helper.id}/account`)
    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe('INVALID_STATE')

    await createUser({ phone: '9833333333', email: null })
    const member = await registerGuard({ phone: '9833333333' })
    const taken = await api.post(`/staff/${member.id}/account`)
    expect(taken.status).toBe(400)
    expect(taken.body.error.message).toMatch(/already in use/)
    expect((await db.select().from(staff).where(eq(staff.id, member.id)))[0]!.userId).toBeNull()
  })

  it('follows the profile to another gate and keeps the posting it ended', async () => {
    const member = await registerGuard()
    await api.post(`/staff/${member.id}/account`)
    const [other] = await db.insert(gates).values({ societyId: TEST_SOCIETY_ID, code: 'BACK', name: 'Back gate' }).returning()

    expect((await api.put(`/staff/${member.id}`, { gateId: other!.id })).status).toBe(200)

    const postings = await db.select().from(guardGateAssignments).orderBy(asc(guardGateAssignments.startAt))
    expect(postings).toHaveLength(2)
    expect(postings[0]!.gateId).toBe(gateId)
    expect(postings[0]!.endAt).not.toBeNull()
    expect(postings[1]).toMatchObject({ gateId: other!.id, endAt: null })
  })

  it('shuts the account down on deactivation and opens it again on reactivation', async () => {
    const member = await registerGuard()
    const { account } = (await api.post(`/staff/${member.id}/account`)).body.data
    const guardToken = `Bearer ${await signTestToken({ userId: account.id, role: 'GUARD', societyId: TEST_SOCIETY_ID })}`
    expect((await api.get('/auth/permissions', guardToken)).status).toBe(200)

    expect((await api.put(`/staff/${member.id}`, { status: 'INACTIVE', reason: 'Left the agency' })).status).toBe(200)

    // The token is still unexpired, and still refused: the session behind it is gone
    expect((await api.get('/auth/permissions', guardToken)).status).toBe(401)
    expect((await db.select().from(users).where(eq(users.id, account.id)))[0]!.isActive).toBe(false)
    const [session] = await db.select().from(authSessions).where(eq(authSessions.userId, account.id))
    expect(session!.revokedReason).toBe('STAFF_DEACTIVATED')
    const ended = await db.select().from(guardGateAssignments).where(eq(guardGateAssignments.guardUserId, account.id))
    expect(ended.every((posting) => posting.endAt !== null)).toBe(true)

    expect((await api.put(`/staff/${member.id}`, { status: 'ACTIVE' })).status).toBe(200)
    expect((await db.select().from(users).where(eq(users.id, account.id)))[0]!.isActive).toBe(true)
    const open = await db.select().from(guardGateAssignments).where(isNull(guardGateAssignments.endAt))
    expect(open).toHaveLength(1)
    expect(open[0]!.gateId).toBe(gateId)
  })
})

describe('reading the staff', () => {
  it('comes a page at a time, with the total behind it', async () => {
    await register(guard())
    await register({ ...guard(), name: 'Anil Kumar', phone: '9844444444' })

    const first = await api.get(`/societies/${TEST_SOCIETY_ID}/staff?kind=GUARD&limit=1`)
    expect(first.body.data.total).toBe(2)
    expect(first.body.data.staff.map((row: { name: string }) => row.name)).toEqual(['Anil Kumar'])

    const second = await api.get(`/societies/${TEST_SOCIETY_ID}/staff?kind=GUARD&limit=1&offset=1`)
    expect(second.body.data.staff.map((row: { name: string }) => row.name)).toEqual(['Mahesh Patil'])
  })

  it('opens one profile with its account, postings and nothing of another society', async () => {
    const member = (await register(guard())).body.data

    const before = await api.get(`/staff/${member.id}`)
    expect(before.status).toBe(200)
    expect(before.body.data).toMatchObject({ account: null, postings: [], gateName: 'Main gate' })

    await api.post(`/staff/${member.id}/account`)
    const after = await api.get(`/staff/${member.id}`)
    expect(after.body.data.account.isActive).toBe(true)
    expect(after.body.data.postings).toEqual([expect.objectContaining({ gateName: 'Main gate', endAt: null })])

    await db.insert(societies).values({ id: OTHER_SOCIETY_ID, name: 'Other Society' })
    const [outside] = await db
      .insert(staff)
      .values({ societyId: OTHER_SOCIETY_ID, kind: 'VENDOR', name: 'Someone Else', phone: '9866666666', passCode: 'CK-OTHER' })
      .returning()
    const denied = await api.get(`/staff/${outside!.id}`)
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('CROSS_SOCIETY_ACCESS')
  })
})

describe('society settings', () => {
  it('insists on a government ID once the society says it is required', async () => {
    await api.put(`/societies/${TEST_SOCIETY_ID}/settings`, { idRequired: true })

    const refused = await register(guard())
    expect(refused.status).toBe(400)
    expect(refused.body.error.message).toMatch(/government ID/)

    const created = await register({ ...guard(), idDocumentType: 'AADHAAR', idDocumentLast4: '1234' })
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({ idDocumentType: 'AADHAAR', idDocumentLast4: '1234' })
  })
})
