import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { gates, guardGateAssignments, processedClientEvents, visits } from '../../db/schema.js'
import { addResident, createFlat, createUser, grantPermissions, TEST_SOCIETY_ID } from '../../test/helpers.js'
import { signAccessToken } from '../auth/tokens.js'
import { MAX_BATCH, MAX_LOCAL_ATTEMPTS } from './sync.schemas.js'

const app = createApp()
const DEVICE = 'guard-phone-1'

let guard: string
let guardUserId: string
let resident: string
let admin: string
let flatId: string
let gateId: string

const tokenFor = (user: { id: string; role: 'ADMIN' | 'RESIDENT' | 'GUARD' }) =>
  signAccessToken({ userId: user.id, sessionId: 's1', role: user.role, societyId: TEST_SOCIETY_ID }).then((t) => `Bearer ${t}`)

/** One batch, as the device sends it. */
const send = (events: object[], token = guard) =>
  request(app).post('/api/v1/sync/events').set('Authorization', token).send({ batchId: randomUUID(), events })

const visitPayload = () => ({
  flatId,
  gateId,
  visitorName: 'Dev Courier',
  visitorPhone: '9833333333',
  purpose: 'DELIVERY',
  people: 1,
})

const event = (overrides: Record<string, unknown> = {}) => ({
  clientEventId: randomUUID(),
  deviceId: DEVICE,
  eventType: 'VISITOR_REGISTER' as const,
  entityId: null,
  payload: visitPayload(),
  clientTs: new Date().toISOString(),
  localAttemptCount: 0,
  ...overrides,
})

const only = (res: { body: { data: { results: { status: string; entityId: string | null; code: string | null }[] } } }) => res.body.data.results[0]!

beforeEach(async () => {
  const guardUser = await createUser({ phone: '9000000002', email: null, role: 'GUARD' })
  guardUserId = guardUser.id
  guard = await tokenFor(guardUser)
  const residentUser = await createUser({ phone: '9876543210', email: null, role: 'RESIDENT' })
  resident = await tokenFor(residentUser)
  const adminUser = await createUser({ phone: '9000000001', email: null, role: 'ADMIN' })
  await grantPermissions(adminUser.id, ['AUDIT_VIEW'])
  admin = await tokenFor(adminUser)
  flatId = (await createFlat()).id
  await addResident(flatId, residentUser.id)
  const [gate] = await db.insert(gates).values({ societyId: TEST_SOCIETY_ID, code: 'MAIN', name: 'Main gate' }).returning()
  gateId = gate!.id
})

describe('POST /sync/events', () => {
  it('OFF-05 applies a queued registration and reports it per event', async () => {
    const res = await send([event()])
    expect(res.status).toBe(200)
    expect(only(res).status).toBe('APPLIED')
    const [visit] = await db.select().from(visits).where(eq(visits.id, only(res).entityId!))
    expect(visit?.visitorName).toBe('Dev Courier')
    expect(visit?.source).toBe('ONLINE')
  })

  it('OFF-06 answers a replay with DUPLICATE_IGNORED and never writes a second visit', async () => {
    const queued = event()
    const first = await send([queued])
    const again = await send([queued])
    expect(only(again).status).toBe('DUPLICATE_IGNORED')
    expect(only(again).entityId).toBe(only(first).entityId)
    expect(await db.$count(visits)).toBe(1)
  })

  it('OFF-07 refuses one bad event without touching the rest of the batch', async () => {
    const good = event()
    const bad = event({ payload: { ...visitPayload(), flatId: randomUUID() } })
    const res = await send([bad, good])
    const byId = new Map(res.body.data.results.map((r: { clientEventId: string }) => [r.clientEventId, r]))
    expect(byId.get(bad.clientEventId)).toMatchObject({ status: 'REJECTED', code: 'NOT_FOUND' })
    expect(byId.get(good.clientEventId)).toMatchObject({ status: 'APPLIED' })
    expect(await db.$count(visits)).toBe(1)
  })

  it('applies the batch in the order the device recorded it', async () => {
    const created = await send([event()])
    const visitId = only(created).entityId!
    await db.update(visits).set({ status: 'APPROVED' }).where(eq(visits.id, visitId))
    // Sent exit-first, but sequence says entry came first
    const res = await send([
      event({ eventType: 'VISIT_EXIT', entityId: visitId, payload: {}, sequence: 2 }),
      event({ eventType: 'VISIT_ENTRY_RECORD', entityId: visitId, payload: { gateId }, sequence: 1 }),
    ])
    expect(res.body.data.results.map((r: { status: string }) => r.status)).toEqual(['APPLIED', 'APPLIED'])
    const [visit] = await db.select().from(visits).where(eq(visits.id, visitId))
    expect(visit?.status).toBe('LEFT')
  })

  it('OFF-04 records an unannounced offline entry as physically in, needing review, with no approval', async () => {
    const res = await send([
      event({ eventType: 'MANUAL_OFFLINE_ENTRY', payload: { ...visitPayload(), reason: 'Resident did not answer the intercom' } }),
    ])
    expect(only(res).status).toBe('APPLIED')
    const [visit] = await db.select().from(visits).where(eq(visits.id, only(res).entityId!))
    expect(visit).toMatchObject({ status: 'INSIDE', source: 'MANUAL_OFFLINE', needsReview: true, decidedBy: null })
    expect(visit?.reviewReason).toBe('Resident did not answer the intercom')
    expect(visit?.enteredAt).not.toBeNull()
  })

  it('OFF-04 will not record a manual offline entry without a reason', async () => {
    const res = await send([event({ eventType: 'MANUAL_OFFLINE_ENTRY', payload: visitPayload() })])
    expect(only(res)).toMatchObject({ status: 'REJECTED', code: 'VALIDATION_ERROR' })
    expect(await db.$count(visits)).toBe(0)
  })

  it('OFF-08 parks an event from a badly wrong device clock for review', async () => {
    const res = await send([event({ clientTs: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() })])
    expect(only(res)).toMatchObject({ status: 'NEEDS_REVIEW', code: 'CLOCK_SKEW' })
    expect(await db.$count(visits)).toBe(0)
  })

  it('OFF-08 hands an event the device has given up on to the office', async () => {
    const res = await send([event({ localAttemptCount: MAX_LOCAL_ATTEMPTS })])
    expect(only(res)).toMatchObject({ status: 'NEEDS_REVIEW', code: 'RETRY_LIMIT_REACHED' })
    expect(await db.$count(visits)).toBe(0)
  })

  it('keeps a refusal, so a replay is answered from the ledger rather than refused again', async () => {
    const bad = event({ payload: { ...visitPayload(), flatId: randomUUID() } })
    await send([bad])
    const [row] = await db.select().from(processedClientEvents).where(eq(processedClientEvents.clientEventId, bad.clientEventId))
    expect(row).toMatchObject({ resultStatus: 'REJECTED', deviceId: DEVICE })
    expect(only(await send([bad])).status).toBe('REJECTED')
  })

  it('retries an event a previous attempt left as FAILED_RETRY', async () => {
    const queued = event()
    await db.insert(processedClientEvents).values({
      clientEventId: queued.clientEventId,
      userId: guardUserId,
      deviceId: DEVICE,
      operationType: 'VISITOR_REGISTER',
      resultStatus: 'FAILED_RETRY',
    })
    expect(only(await send([queued])).status).toBe('APPLIED')
  })

  it('takes over a claim left behind by a request that died', async () => {
    const queued = event()
    await db.insert(processedClientEvents).values({
      clientEventId: queued.clientEventId,
      userId: guardUserId,
      deviceId: DEVICE,
      operationType: 'VISITOR_REGISTER',
      claimedAt: new Date(Date.now() - 10 * 60 * 1000),
    })
    expect(only(await send([queued])).status).toBe('APPLIED')
    expect(await db.$count(visits)).toBe(1)
  })

  it('tells the device to come back while another request holds the same id', async () => {
    const queued = event()
    await db.insert(processedClientEvents).values({
      clientEventId: queued.clientEventId,
      userId: guardUserId,
      deviceId: DEVICE,
      operationType: 'VISITOR_REGISTER',
    })
    expect(only(await send([queued])).status).toBe('FAILED_RETRY')
    expect(await db.$count(visits)).toBe(0)
  })

  it('does not register twice when a reclaimed event had already committed its visit', async () => {
    const queued = event()
    await send([queued])
    await db
      .update(processedClientEvents)
      .set({ resultStatus: 'FAILED_RETRY' })
      .where(eq(processedClientEvents.clientEventId, queued.clientEventId))
    expect(only(await send([queued])).status).toBe('DUPLICATE_IGNORED')
    expect(await db.$count(visits)).toBe(1)
  })

  it('refuses an event id replayed by another account', async () => {
    const queued = event()
    await send([queued])
    const other = await tokenFor(await createUser({ phone: '9000000009', email: null, role: 'GUARD' }))
    expect(only(await send([queued], other))).toMatchObject({ status: 'REJECTED', code: 'PERMISSION_DENIED' })
  })

  it('refuses a resident, who has no gate permissions', async () => {
    expect((await send([event()], resident)).status).toBe(403)
  })

  it('GST-02 refuses an event for a gate the guard is not posted to', async () => {
    const [other] = await db.insert(gates).values({ societyId: TEST_SOCIETY_ID, code: 'REAR', name: 'Rear gate' }).returning()
    await db.insert(guardGateAssignments).values({ guardUserId, gateId: other!.id, assignedBy: guardUserId })
    expect(only(await send([event()]))).toMatchObject({ status: 'REJECTED', code: 'GATE_ACCESS_DENIED' })
    expect(await db.$count(visits)).toBe(0)
  })

  it('accepts the gate the guard is posted to', async () => {
    await db.insert(guardGateAssignments).values({ guardUserId, gateId, assignedBy: guardUserId })
    expect(only(await send([event()])).status).toBe('APPLIED')
  })

  it('rejects a batch larger than the fixed maximum', async () => {
    const res = await send(Array.from({ length: MAX_BATCH + 1 }, () => event()))
    expect(res.status).toBe(422)
    expect(await db.$count(visits)).toBe(0)
  })

  it('lists the events waiting for the office', async () => {
    await send([event({ localAttemptCount: MAX_LOCAL_ATTEMPTS })])
    const res = await request(app).get('/api/v1/sync/needs-review').set('Authorization', admin)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].code).toBe('RETRY_LIMIT_REACHED')
  })
})
