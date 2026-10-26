import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { gates, societies, staff } from '../../db/schema.js'
import { createFlat, createUser, grantPermissions, TEST_SOCIETY_ID } from '../../test/helpers.js'
import { signAccessToken } from '../auth/tokens.js'

const OTHER_SOCIETY_ID = '33333333-3333-4333-8333-333333333333'
const app = createApp()

let auth: string
let gateId: string
let flatId: string

async function tokenFor(user: { id: string; role: 'ADMIN' | 'RESIDENT' | 'GUARD' }) {
  return `Bearer ${await signAccessToken({ userId: user.id, sessionId: 's1', role: user.role, societyId: TEST_SOCIETY_ID })}`
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
})
const help = () => ({
  kind: 'DAILY_HELP' as const,
  name: 'Sunita Devi',
  phone: '9822222222',
  workType: 'Maid',
  workingDays: ['MON', 'WED', 'TUE'] as const,
  flatsServed: [{ flatId, timeWindow: '7-9 am' }],
  passValidFrom: '2026-01-01',
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
    expect(list.body.data.map((row: { kind: string }) => row.kind)).toEqual(['GUARD'])
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
    expect(list.body.data[0]).toMatchObject({
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
    expect(list.body.data[0].flatsServed).toEqual([expect.objectContaining({ flatId, timeWindow: '7-9 am' })])
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
    expect(list.body.data[0].flatsServed).toEqual([expect.objectContaining({ flatId: second.id })])

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

    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff?search=mahesh`)).body.data).toHaveLength(1)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff?search=98111`)).body.data).toHaveLength(1)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff?search=nobody`)).body.data).toHaveLength(0)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff?status=ACTIVE`)).body.data).toHaveLength(0)
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
