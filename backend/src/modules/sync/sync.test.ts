import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { gates, processedClientEvents, visits } from '../../db/schema.js'
import { addResident, createFlat, createUser, TEST_SOCIETY_ID } from '../../test/helpers.js'
import { signAccessToken } from '../auth/tokens.js'

const app = createApp()

let guard: string
let guardUserId: string
let resident: string
let flatId: string
let gateId: string

const tokenFor = (user: { id: string; role: 'ADMIN' | 'RESIDENT' | 'GUARD' }) =>
  signAccessToken({ userId: user.id, sessionId: 's1', role: user.role, societyId: TEST_SOCIETY_ID }).then((t) => `Bearer ${t}`)

const send = (body: object, token = guard) =>
  request(app).post('/api/v1/sync/events').set('Authorization', token).send(body)

const event = (overrides: object = {}) => ({
  clientEventId: randomUUID(),
  operationType: 'VISITOR_REGISTER' as const,
  entityId: null,
  payload: { flatId, gateId, visitorName: 'Dev Courier', visitorPhone: '9833333333', purpose: 'DELIVERY', people: 1 },
  clientTs: new Date().toISOString(),
  ...overrides,
})

beforeEach(async () => {
  const guardUser = await createUser({ phone: '9000000002', email: null, role: 'GUARD' })
  guardUserId = guardUser.id
  guard = await tokenFor(guardUser)
  const residentUser = await createUser({ phone: '9876543210', email: null, role: 'RESIDENT' })
  resident = await tokenFor(residentUser)
  flatId = (await createFlat()).id
  await addResident(flatId, residentUser.id)
  const [gate] = await db.insert(gates).values({ societyId: TEST_SOCIETY_ID, name: 'Main gate' }).returning()
  gateId = gate!.id
})

describe('POST /sync/events', () => {
  it('applies a queued visitor registration', async () => {
    const res = await send(event())
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('APPLIED')
    const [visit] = await db.select().from(visits).where(eq(visits.id, res.body.data.entityId))
    expect(visit?.visitorName).toBe('Dev Courier')
    expect(visit?.status).toBe('WAITING')
  })

  it('answers a replayed event from the ledger without registering a second visit', async () => {
    const body = event()
    const first = await send(body)
    const second = await send(body)
    expect(second.status).toBe(200)
    expect(second.body.data.entityId).toBe(first.body.data.entityId)
    expect(await db.$count(visits)).toBe(1)
  })

  it('records an entry and an exit for a visit it created', async () => {
    const created = await send(event())
    const visitId = created.body.data.entityId
    await db.update(visits).set({ status: 'APPROVED' }).where(eq(visits.id, visitId))

    const entry = await send(event({ operationType: 'VISIT_ENTRY_RECORD', entityId: visitId, payload: { gateId } }))
    expect(entry.body.data.status).toBe('APPLIED')
    const exit = await send(event({ operationType: 'VISIT_EXIT', entityId: visitId, payload: {} }))
    expect(exit.body.data.status).toBe('APPLIED')
    const [visit] = await db.select().from(visits).where(eq(visits.id, visitId))
    expect(visit?.status).toBe('LEFT')
  })

  it('remembers a refusal so the device stops retrying it', async () => {
    const body = event({ payload: { ...event().payload, flatId: randomUUID() } })
    const res = await send(body)
    expect(res.status).toBe(404)
    const [row] = await db.select().from(processedClientEvents).where(eq(processedClientEvents.clientEventId, body.clientEventId))
    expect(row?.resultStatus).toBe('REJECTED')
    // The replay is answered from the ledger, not refused a second time
    expect((await send(body)).body.data.status).toBe('REJECTED')
  })

  it('takes over a claim left behind by a request that died, and applies it once', async () => {
    const body = event()
    await db.insert(processedClientEvents).values({
      clientEventId: body.clientEventId,
      userId: guardUserId,
      operationType: 'VISITOR_REGISTER',
      claimedAt: new Date(Date.now() - 10 * 60 * 1000),
    })
    const res = await send(body)
    expect(res.body.data.status).toBe('APPLIED')
    expect(await db.$count(visits)).toBe(1)
  })

  it('tells the device to come back while another request holds the same id', async () => {
    const body = event()
    await db.insert(processedClientEvents).values({
      clientEventId: body.clientEventId,
      userId: guardUserId,
      operationType: 'VISITOR_REGISTER',
    })
    const res = await send(body)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('SYNC_IN_PROGRESS')
    expect(await db.$count(visits)).toBe(0)
  })

  it('does not register twice when a reclaimed event had already committed its visit', async () => {
    const body = event()
    await send(body)
    // The claim is lost, but the visit carries the id, so the replay is recognised
    await db.update(processedClientEvents).set({ resultStatus: 'IN_PROGRESS', claimedAt: new Date(0) })
      .where(eq(processedClientEvents.clientEventId, body.clientEventId))
    const res = await send(body)
    expect(res.body.data.status).toBe('DUPLICATE_IGNORED')
    expect(await db.$count(visits)).toBe(1)
  })

  it('parks an event from a badly wrong device clock for review', async () => {
    const body = event({ clientTs: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() })
    const res = await send(body)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'NEEDS_REVIEW', resultCode: 'CLOCK_SKEW' })
    expect(await db.$count(visits)).toBe(0)
  })

  it('refuses an event id replayed by another account', async () => {
    const body = event()
    await send(body)
    const other = await tokenFor(await createUser({ phone: '9000000009', email: null, role: 'GUARD' }))
    const res = await send(body, other)
    expect(res.status).toBe(403)
  })

  it('refuses a resident, who has no gate permissions', async () => {
    expect((await send(event(), resident)).status).toBe(403)
  })
})
