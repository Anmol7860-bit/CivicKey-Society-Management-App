import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { auditLogs, flatResidents, societies } from '../../db/schema.js'
import { createUser, grantPermissions, TEST_SOCIETY_ID } from '../../test/helpers.js'
import { signAccessToken } from '../auth/tokens.js'

const OTHER_SOCIETY_ID = '33333333-3333-4333-8333-333333333333'
const MISSING_ID = '44444444-4444-4444-8444-444444444444'
const app = createApp()

let auth: string

async function tokenFor(user: { id: string; role: 'ADMIN' | 'RESIDENT' | 'GUARD' }) {
  return `Bearer ${await signAccessToken({ userId: user.id, sessionId: 's1', role: user.role, societyId: TEST_SOCIETY_ID })}`
}

const api = {
  get: (path: string, token = auth) => request(app).get(`/api/v1${path}`).set('Authorization', token),
  post: (path: string, body: object, token = auth) => request(app).post(`/api/v1${path}`).set('Authorization', token).send(body),
  put: (path: string, body: object, token = auth) => request(app).put(`/api/v1${path}`).set('Authorization', token).send(body),
}

async function block(name = 'A') {
  return (await api.post(`/societies/${TEST_SOCIETY_ID}/blocks`, { name })).body.data
}
async function floor(blockId: string, label = '1st Floor', displayOrder?: number) {
  return (await api.post(`/blocks/${blockId}/floors`, { label, displayOrder })).body.data
}
async function flat(floorId: string, number = '101') {
  return (await api.post(`/floors/${floorId}/flats`, { number })).body.data
}

beforeEach(async () => {
  const admin = await createUser({ phone: '9000000001', email: null, role: 'ADMIN' })
  await grantPermissions(admin.id, ['SOCIETY_MANAGE'])
  auth = await tokenFor(admin)
})

describe('authorization', () => {
  it('requires a token and SOCIETY_MANAGE', async () => {
    const committee = await createUser({ phone: '9000000002', email: null, role: 'ADMIN', residentType: 'TENANT' })
    await grantPermissions(committee.id, ['INVOICE_GENERATE'])
    const resident = await createUser({ phone: '9000000003', email: null })

    expect((await request(app).get('/api/v1/societies')).status).toBe(401)
    for (const user of [committee, resident]) {
      const res = await api.get('/societies', await tokenFor(user))
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('PERMISSION_DENIED')
    }
  })

  it('lists only the Admin’s own society and refuses another one', async () => {
    await db.insert(societies).values({ id: OTHER_SOCIETY_ID, name: 'Other' })

    const list = await api.get('/societies')
    expect(list.body.data.map((s: { id: string }) => s.id)).toEqual([TEST_SOCIETY_ID])

    for (const res of [
      await api.get(`/societies/${OTHER_SOCIETY_ID}`),
      await api.post(`/societies/${OTHER_SOCIETY_ID}/blocks`, { name: 'X' }),
    ]) {
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('CROSS_SOCIETY_ACCESS')
    }
  })

  it('returns 404 for unknown and malformed ids', async () => {
    for (const path of [`/societies/${MISSING_ID}`, '/blocks/nope/floors', `/floors/${MISSING_ID}/flats`, '/flats/nope']) {
      expect((await api.get(path)).status).toBe(404)
    }
  })
})

describe('society', () => {
  it('updates details and records an audit event', async () => {
    const res = await api.put(`/societies/${TEST_SOCIETY_ID}`, { name: '  Green Meadows ', address: 'Pune' })

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ name: 'Green Meadows', address: 'Pune' })
    const [event] = await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'SOCIETY_UPDATED'))
    expect(event!.metadata).toMatchObject({ societyId: TEST_SOCIETY_ID, changes: { name: 'Green Meadows' } })
  })

  it('rejects an empty or unknown-field update', async () => {
    expect((await api.put(`/societies/${TEST_SOCIETY_ID}`, {})).status).toBe(422)
    expect((await api.put(`/societies/${TEST_SOCIETY_ID}`, { name: ' ' })).status).toBe(422)
    expect((await api.put(`/societies/${TEST_SOCIETY_ID}`, { id: OTHER_SOCIETY_ID })).status).toBe(422)
  })
})

describe('blocks', () => {
  it('creates, lists and rejects a duplicate name ignoring case', async () => {
    const a = await block('Tower A')
    await block('Tower B')

    const dup = await api.post(`/societies/${TEST_SOCIETY_ID}/blocks`, { name: ' tower a ' })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('ALREADY_EXISTS')
    expect((await api.put(`/blocks/${a.id}`, { name: 'TOWER B' })).status).toBe(409)

    const list = await api.get(`/societies/${TEST_SOCIETY_ID}/blocks`)
    expect(list.body.data.map((b: { name: string }) => b.name)).toEqual(['Tower A', 'Tower B'])
  })

  it('cannot be deactivated while it has active floors, and then takes no new floors', async () => {
    const a = await block()
    const f = await floor(a.id)

    const refused = await api.put(`/blocks/${a.id}`, { isActive: false })
    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe('INVALID_STATE')

    expect((await api.put(`/floors/${f.id}`, { isActive: false })).status).toBe(200)
    expect((await api.put(`/blocks/${a.id}`, { isActive: false })).body.data.isActive).toBe(false)
    expect((await api.post(`/blocks/${a.id}/floors`, { label: 'Terrace' })).status).toBe(400)
    // An inactive block cannot regain an active floor either
    expect((await api.put(`/floors/${f.id}`, { isActive: true })).status).toBe(400)
    // History stays readable
    expect((await api.get(`/blocks/${a.id}/floors`)).body.data).toHaveLength(1)
  })
})

describe('floors', () => {
  it('stores free-text labels trimmed and lists them by display order', async () => {
    const a = await block()
    await floor(a.id, 'Terrace')
    await floor(a.id, '  1st   Floor ', 1)
    await floor(a.id, 'B2', -2)
    await floor(a.id, 'Ground', 0)

    const list = await api.get(`/blocks/${a.id}/floors`)
    expect(list.body.data.map((f: { label: string }) => f.label)).toEqual(['B2', 'Ground', '1st Floor', 'Terrace'])
  })

  it('rejects a blank label and a duplicate normalized label in the same block only', async () => {
    const a = await block('A')
    const b = await block('B')
    await floor(a.id, '1st Floor')

    expect((await api.post(`/blocks/${a.id}/floors`, { label: '   ' })).status).toBe(422)
    expect((await api.post(`/blocks/${a.id}/floors`, { label: ' 1ST  floor' })).status).toBe(409)
    expect((await api.post(`/blocks/${b.id}/floors`, { label: '1st Floor' })).status).toBe(201)
  })

  it('cannot be deactivated while it has active flats', async () => {
    const f = await floor((await block()).id)
    const unit = await flat(f.id)

    expect((await api.put(`/floors/${f.id}`, { isActive: false })).status).toBe(400)
    await api.put(`/flats/${unit.id}`, { isActive: false })
    expect((await api.put(`/floors/${f.id}`, { isActive: false })).status).toBe(200)
    expect((await api.post(`/floors/${f.id}/flats`, { number: '102' })).status).toBe(400)
  })
})

describe('flats', () => {
  it('derives block and society from the floor and returns them in the details', async () => {
    const a = await block('A')
    const f = await floor(a.id, 'Ground')

    const created = await api.post(`/floors/${f.id}/flats`, { number: ' G-01 ' })
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({ number: 'G-01', floorId: f.id, blockId: a.id, societyId: TEST_SOCIETY_ID })

    const details = await api.get(`/flats/${created.body.data.id}`)
    expect(details.body.data).toMatchObject({ block: { id: a.id, name: 'A' }, floor: { id: f.id, label: 'Ground' } })
    // The hierarchy is never taken from the body
    expect((await api.post(`/floors/${f.id}/flats`, { number: '2', societyId: OTHER_SOCIETY_ID })).status).toBe(422)
  })

  it('keeps flat numbers unique within the block, across its floors', async () => {
    const a = await block('A')
    const first = await floor(a.id, '1st Floor')
    const second = await floor(a.id, '2nd Floor')
    const other = await floor((await block('B')).id, '1st Floor')
    await flat(first.id, '101')

    expect((await api.post(`/floors/${second.id}/flats`, { number: '101' })).status).toBe(409)
    expect((await api.post(`/floors/${other.id}/flats`, { number: '101' })).status).toBe(201)
  })

  it('moves to another floor and takes that floor’s block', async () => {
    const unit = await flat((await floor((await block('A')).id)).id)
    const b = await block('B')
    const target = await floor(b.id, 'Ground')

    const res = await api.put(`/flats/${unit.id}`, { floorId: target.id })

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ floorId: target.id, blockId: b.id })
  })

  it('cannot be deactivated while it has current or upcoming residents', async () => {
    const unit = await flat((await floor((await block()).id)).id)
    const resident = await createUser({ phone: '9000000004', email: null })
    await db.insert(flatResidents).values({ flatId: unit.id, userId: resident.id })

    const refused = await api.put(`/flats/${unit.id}`, { isActive: false })
    expect(refused.status).toBe(400)

    await db.update(flatResidents).set({ endDate: '2020-01-01', startDate: '2019-01-01' }).where(eq(flatResidents.flatId, unit.id))
    expect((await api.put(`/flats/${unit.id}`, { isActive: false })).body.data.isActive).toBe(false)
  })
})
