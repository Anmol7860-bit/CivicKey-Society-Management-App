import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { blocks, gates, guardGateAssignments, notificationOutbox, societies, staff, staffFlats, visitorPasses, visits } from '../../db/schema.js'
import { addResident, createFlat, createPhoto, createUser, grantPermissions, TEST_SOCIETY_ID, signTestToken } from '../../test/helpers.js'

const app = createApp()
const OTHER_SOCIETY_ID = '33333333-3333-4333-8333-333333333333'

let guard: string
let resident: string
let admin: string
let flatId: string
let gateId: string
let residentUserId: string
let guardUserId: string
let photoId: string

function tokenFor(user: { id: string; role: 'ADMIN' | 'RESIDENT' | 'GUARD' }) {
  return signTestToken({ userId: user.id, role: user.role, societyId: TEST_SOCIETY_ID }).then((token) => `Bearer ${token}`)
}

const api = {
  get: (path: string, token: string) => request(app).get(`/api/v1${path}`).set('Authorization', token),
  post: (path: string, body: object = {}, token = guard) => request(app).post(`/api/v1${path}`).set('Authorization', token).send(body),
  put: (path: string, body: object = {}, token = guard) => request(app).put(`/api/v1${path}`).set('Authorization', token).send(body),
  del: (path: string, token: string) => request(app).delete(`/api/v1${path}`).set('Authorization', token),
}

/** Today, and a window around now, so a pass written by a test is usable right now. */
const today = () => new Date().toISOString().slice(0, 10)
const passBody = (overrides: object = {}) => ({
  visitorName: 'Amit Kulkarni',
  visitorPhone: '9822222222',
  purpose: 'GUEST' as const,
  people: 2,
  validOn: today(),
  validFrom: '00:00',
  validUntil: '23:59',
  vehicleNumber: 'MH 12 AB 3344',
  note: 'Parcel can be left with security',
  ...overrides,
})

/** What the guard's form sends: the photograph and the expected time are part of every one. */
const visitBody = (overrides: object = {}) => ({
  flatId,
  gateId,
  visitorName: 'Dev Courier',
  visitorPhone: '9833333333',
  purpose: 'DELIVERY' as const,
  people: 1,
  photoReference: photoId,
  expectedDate: today(),
  expectedTime: '10:30',
  ...overrides,
})

beforeEach(async () => {
  photoId = await createPhoto()
  const guardUser = await createUser({ phone: '9000000002', email: null, role: 'GUARD' })
  guardUserId = guardUser.id
  guard = await tokenFor(guardUser)

  const residentUser = await createUser({ phone: '9876543210', email: null, role: 'RESIDENT' })
  residentUserId = residentUser.id
  resident = await tokenFor(residentUser)

  const adminUser = await createUser({ phone: '9000000001', email: null, role: 'ADMIN' })
  await grantPermissions(adminUser.id, ['USER_MANAGE', 'STAFF_MANAGE', 'SOCIETY_MANAGE'])
  admin = await tokenFor(adminUser)

  flatId = (await createFlat()).id
  await addResident(flatId, residentUser.id)
  const [gate] = await db.insert(gates).values({ societyId: TEST_SOCIETY_ID, code: 'MAIN', name: 'Main gate' }).returning()
  gateId = gate!.id
})

describe('visitor passes', () => {
  it('issues a six-digit code the guard can check, and closes it on entry', async () => {
    const created = await api.post(`/flats/${flatId}/passes`, passBody(), resident)
    expect(created.status).toBe(201)
    expect(created.body.data.entryCode).toMatch(/^\d{6}$/)
    expect(created.body.data.flat.label).toBe('A-101-101')

    const checked = await api.get(`/societies/${TEST_SOCIETY_ID}/passes/validate?code=${created.body.data.entryCode}`, guard)
    expect(checked.body.data).toMatchObject({ valid: true, reason: null })
    expect(checked.body.data.pass.note).toBe('Parcel can be left with security')

    // Arriving with the pass approves the visit outright, and letting them in uses the pass up
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ entryCode: created.body.data.entryCode }))
    expect(visit.body.data.status).toBe('APPROVED')
    await api.post(`/visits/${visit.body.data.id}/entry`, {})

    const [pass] = await db.select().from(visitorPasses).where(eq(visitorPasses.id, created.body.data.id))
    expect(pass!.status).toBe('USED')
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/passes/validate?code=${pass!.entryCode}`, guard)).body.data).toMatchObject({
      valid: false,
      reason: 'This pass has already been used',
    })
  })

  it('refuses a cancelled pass and one that is not valid today', async () => {
    const created = await api.post(`/flats/${flatId}/passes`, passBody(), resident)
    const cancelled = await api.post(`/passes/${created.body.data.id}/cancel`, {}, resident)
    expect(cancelled.body.data.status).toBe('CANCELLED')
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/passes/validate?code=${created.body.data.entryCode}`, guard)).body.data).toMatchObject({
      valid: false,
      reason: 'The resident cancelled this pass',
    })
    // Cancelling twice is refused rather than silently repeated
    expect((await api.post(`/passes/${created.body.data.id}/cancel`, {}, resident)).status).toBe(400)

    const yesterday = await api.post(`/flats/${flatId}/passes`, passBody({ validOn: '2024-01-01' }), resident)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/passes/validate?code=${yesterday.body.data.entryCode}`, guard)).body.data.reason).toBe(
      'This pass expired',
    )

    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/passes/validate?code=000000`, guard)).body.data).toMatchObject({
      valid: false,
      pass: null,
    })
  })

  it('refuses a pass window that ends before it starts, and a pass for someone else’s flat', async () => {
    const bad = await api.post(`/flats/${flatId}/passes`, passBody({ validFrom: '18:00', validUntil: '09:00' }), resident)
    expect(bad.status).toBe(422)

    const other = await createUser({ phone: '9811111119', email: null, role: 'RESIDENT' })
    expect((await api.post(`/flats/${flatId}/passes`, passBody(), await tokenFor(other))).status).toBe(403)
  })
})

describe('visits', () => {
  it('goes straight to the guard when the flat has nobody who can answer', async () => {
    const empty = await createFlat(TEST_SOCIETY_ID, '902')
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ flatId: empty.id }))

    // Nobody to ask, so it does not sit waiting three minutes for a decision that cannot come
    expect(visit.body.data.status).toBe('AWAITING_MANUAL')
  })

  it('asks the tenant, not the owner, while a tenant is in the flat', async () => {
    const shared = await createFlat(TEST_SOCIETY_ID, '903')
    const owner = await createUser({ phone: '9811111101', email: null, role: 'RESIDENT' })
    const tenant = await createUser({ phone: '9811111102', email: null, role: 'RESIDENT' })
    await addResident(shared.id, owner.id, { residentType: 'OWNER', accessLevel: 'VIEW_ONLY' })
    await addResident(shared.id, tenant.id, { residentType: 'TENANT' })

    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ flatId: shared.id }))
    expect(visit.body.data.status).toBe('AWAITING_APPROVAL')

    // The owner is view-only while the tenant is active, so the tenant is the one who decides
    expect((await api.post(`/visits/${visit.body.data.id}/decision`, { decision: 'APPROVED' }, await tokenFor(tenant))).status).toBe(200)
  })

  it('insists on the photograph, the expected time and, for a guest, who they asked for', async () => {
    const { photoReference: _photo, ...noPhoto } = visitBody()
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, noPhoto)).status).toBe(422)

    const { expectedTime: _time, ...noTime } = visitBody()
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, noTime)).status).toBe(422)

    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ purpose: 'GUEST' }))).status).toBe(422)

    // The photograph has to be one this society actually stored
    const elsewhere = await createPhoto(OTHER_SOCIETY_ID)
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ photoReference: elsewhere }))).status).toBe(404)

    // ...and the resident has to live in the flat the visitor is here for
    const stranger = await createUser({ phone: '9811111117', email: null, role: 'RESIDENT' })
    expect(
      (await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ purpose: 'GUEST', intendedResidentId: stranger.id }))).status,
    ).toBe(400)

    // A flat in a closed block takes no visitors, however active the flat itself is
    await db.update(blocks).set({ status: 'INACTIVE' }).where(eq(blocks.societyId, TEST_SOCIETY_ID))
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())).status).toBe(400)
  })

  it('asks the resident the visitor came to see, and keeps the expected time they gave', async () => {
    const other = await createUser({ phone: '9811111116', email: null, role: 'RESIDENT' })
    await addResident(flatId, other.id, { residentType: 'OWNER' })

    const visit = await api.post(
      `/societies/${TEST_SOCIETY_ID}/visits`,
      visitBody({ purpose: 'GUEST', visitorName: 'Asha Mehta', intendedResidentId: other.id, expectedTime: '18:45' }),
    )
    expect(visit.status).toBe(201)
    expect(visit.body.data.intendedResidentId).toBe(other.id)
    expect(new Date(visit.body.data.expectedAt).getHours()).toBe(18)
    // The registration time is its own field; the expected time is what the guard typed
    expect(visit.body.data.createdAt).not.toBe(visit.body.data.expectedAt)

    const [queued] = await db.select().from(notificationOutbox).where(eq(notificationOutbox.entityId, visit.body.data.id))
    expect(queued).toMatchObject({ eventType: 'VISITOR_WAITING_APPROVAL', recipientIds: [other.id] })
  })

  it('refuses the same form twice, so a retry cannot register two visits', async () => {
    const clientEventId = '55555555-5555-4555-8555-555555555555'
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ clientEventId }))).status).toBe(201)

    const again = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ clientEventId }))
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('ALREADY_EXISTS')
  })

  it('offers the society\u2019s own visitor types and refuses one it does not use', async () => {
    const all = await api.get(`/societies/${TEST_SOCIETY_ID}/visit-purposes`, guard)
    expect(all.body.data).toEqual([
      'GUEST',
      'FOOD_DELIVERY',
      'DELIVERY',
      'CAB',
      'DOMESTIC_HELP',
      'MAINTENANCE',
      'SERVICE',
      'BUSINESS',
      'OTHER',
    ])

    // The society narrows the list from its settings; no code change, no deployment
    await api.put(`/societies/${TEST_SOCIETY_ID}/settings`, { visitorPurposes: ['GUEST', 'DELIVERY'] }, admin)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/visit-purposes`, guard)).body.data).toEqual(['GUEST', 'DELIVERY'])
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ purpose: 'CAB' }))).status).toBe(400)

    // "Other" is not a description, so the guard writes one
    await api.put(`/societies/${TEST_SOCIETY_ID}/settings`, { visitorPurposes: [] }, admin)
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ purpose: 'OTHER' }))).status).toBe(422)
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ purpose: 'OTHER', note: 'Meter reading' }))).status).toBe(201)
  })

  it('asks every household approver at once when nobody was named', async () => {
    const spouse = await createUser({ phone: '9811111111', email: null, role: 'RESIDENT' })
    await addResident(flatId, spouse.id, { relationship: 'Spouse' })

    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    const [queued] = await db.select().from(notificationOutbox).where(eq(notificationOutbox.entityId, visit.body.data.id))
    expect(queued!.recipientIds).toEqual(expect.arrayContaining([residentUserId, spouse.id]))
    expect(queued!.recipientIds).toHaveLength(2)

    // One of them is enough, and the other cannot overwrite the answer afterwards
    expect((await api.post(`/visits/${visit.body.data.id}/decision`, { decision: 'APPROVED' }, await tokenFor(spouse))).status).toBe(200)
    expect((await api.post(`/visits/${visit.body.data.id}/decision`, { decision: 'DENIED' }, resident)).status).toBe(400)
  })

  it('leaves a resident the Admin did not set up for visitors out of it', async () => {
    const child = await createUser({ phone: '9811111112', email: null, role: 'RESIDENT' })
    await addResident(flatId, child.id, { relationship: 'Son', visitorApprovalEligible: false })

    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    const [queued] = await db.select().from(notificationOutbox).where(eq(notificationOutbox.entityId, visit.body.data.id))
    expect(queued!.recipientIds).toEqual([residentUserId])
    expect((await api.post(`/visits/${visit.body.data.id}/decision`, { decision: 'APPROVED' }, await tokenFor(child))).status).toBe(400)

    // Asked for by name, they still cannot answer; the flat's approver is asked instead
    const named = await api.post(
      `/societies/${TEST_SOCIETY_ID}/visits`,
      visitBody({ purpose: 'GUEST', intendedResidentId: child.id, visitorPhone: '9844444441' }),
    )
    expect(named.body.data.intendedResidentId).toBe(child.id)
    const [forNamed] = await db.select().from(notificationOutbox).where(eq(notificationOutbox.entityId, named.body.data.id))
    expect(forNamed!.recipientIds).toEqual([residentUserId])
  })

  it('hands the guard a number to ring when the flat has nobody who may approve', async () => {
    const quiet = await createFlat(TEST_SOCIETY_ID, '904')
    const child = await createUser({ phone: '9811111113', email: null, role: 'RESIDENT' })
    await addResident(quiet.id, child.id, { visitorApprovalEligible: false })

    const visit = await api.post(
      `/societies/${TEST_SOCIETY_ID}/visits`,
      visitBody({ flatId: quiet.id, purpose: 'GUEST', intendedResidentId: child.id }),
    )
    // Not approved, and no decision recorded against anyone
    expect(visit.body.data.status).toBe('AWAITING_MANUAL')
    expect(visit.body.data.decidedBy).toBeNull()
    expect(visit.body.data.contact).toEqual({ name: expect.any(String), phone: '9811111113' })
  })

  it('leaves a parcel at the gate only for a delivery, and only while the society allows it', async () => {
    const guest = await api.post(
      `/societies/${TEST_SOCIETY_ID}/visits`,
      visitBody({ purpose: 'GUEST', intendedResidentId: residentUserId }),
    )
    expect((await api.post(`/visits/${guest.body.data.id}/decision`, { decision: 'LEAVE_AT_GATE' }, resident)).status).toBe(400)

    await api.put(`/societies/${TEST_SOCIETY_ID}/settings`, { leaveAtGateAllowed: false }, admin)
    const parcel = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ visitorPhone: '9844444442' }))
    expect((await api.post(`/visits/${parcel.body.data.id}/decision`, { decision: 'LEAVE_AT_GATE' }, resident)).status).toBe(400)

    await api.put(`/societies/${TEST_SOCIETY_ID}/settings`, { leaveAtGateAllowed: true }, admin)
    expect((await api.post(`/visits/${parcel.body.data.id}/decision`, { decision: 'LEAVE_AT_GATE' }, resident)).status).toBe(200)
  })

  it('gives every visit of the same person its own id, and never lets a closed one back in', async () => {
    const first = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    const second = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    expect(second.status).toBe(201)
    expect(second.body.data.id).not.toBe(first.body.data.id)

    await api.post(`/visits/${first.body.data.id}/decision`, { decision: 'APPROVED' }, resident)
    await api.post(`/visits/${first.body.data.id}/entry`, { gateId })
    await api.post(`/visits/${first.body.data.id}/exit`, {})
    // Closed is closed: the same record cannot carry a second visit
    expect((await api.post(`/visits/${first.body.data.id}/entry`, { gateId })).status).toBe(400)
  })

  it('expires a registration after the society\u2019s own window, and only for a new entry', async () => {
    await api.put(`/societies/${TEST_SOCIETY_ID}/settings`, { visitValidityHours: 2 }, admin)
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    const hours = (new Date(visit.body.data.expiresAt).getTime() - new Date(visit.body.data.createdAt).getTime()) / 3600_000
    expect(hours).toBeCloseTo(2, 1)

    await api.post(`/visits/${visit.body.data.id}/decision`, { decision: 'APPROVED' }, resident)
    await db.update(visits).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(visits.id, visit.body.data.id))
    expect((await api.post(`/visits/${visit.body.data.id}/entry`, { gateId })).status).toBe(400)

    // Already inside when it expires: the visit stays open and the exit is still the guard's
    const inside = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ visitorPhone: '9844444443' }))
    await api.post(`/visits/${inside.body.data.id}/decision`, { decision: 'APPROVED' }, resident)
    await api.post(`/visits/${inside.body.data.id}/entry`, { gateId })
    await db.update(visits).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(visits.id, inside.body.data.id))
    const [stillInside] = await db.select().from(visits).where(eq(visits.id, inside.body.data.id))
    expect(stillInside!.status).toBe('ENTERED')
    expect(stillInside!.exitedAt).toBeNull()
    const left = await api.post(`/visits/${inside.body.data.id}/exit`, {})
    expect(left.body.data.status).toBe('CLOSED')
  })

  it('keeps a pre-approved visit on its pass window instead of the standard day', async () => {
    const pass = await api.post(`/flats/${flatId}/passes`, passBody({ validUntil: '23:59' }), resident)
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ entryCode: pass.body.data.entryCode }))
    expect(new Date(visit.body.data.expiresAt).toISOString().slice(0, 10)).toBe(today())
    expect(new Date(visit.body.data.expiresAt).getHours()).toBe(23)
  })

  it('lets the resident call a visit off, and nobody else', async () => {
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    // The guard who registered it cannot cancel it
    expect((await api.post(`/visits/${visit.body.data.id}/cancel`, {})).status).toBe(403)

    const cancelled = await api.post(`/visits/${visit.body.data.id}/cancel`, { reason: 'Rescheduled' }, resident)
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', cancelledBy: residentUserId, cancellationReason: 'Rescheduled' })
    expect(cancelled.body.data.cancelledAt).not.toBeNull()
    // No exit was invented, and the visitor cannot now be let in
    expect(cancelled.body.data.exitedAt).toBeNull()
    expect((await api.post(`/visits/${visit.body.data.id}/entry`, { gateId })).status).toBe(400)
    expect((await api.post(`/visits/${visit.body.data.id}/cancel`, {}, resident)).status).toBe(400)
  })

  it('refuses to cancel a visitor who is already inside', async () => {
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    await api.post(`/visits/${visit.body.data.id}/decision`, { decision: 'APPROVED' }, resident)
    await api.post(`/visits/${visit.body.data.id}/entry`, { gateId })
    expect((await api.post(`/visits/${visit.body.data.id}/cancel`, {}, resident)).status).toBe(400)
  })

  it('records a gate rejection with its reason, apart from a resident\u2019s denial', async () => {
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    expect((await api.post(`/visits/${visit.body.data.id}/gate-rejection`, { reason: 'OTHER' })).status).toBe(422)

    const refused = await api.post(`/visits/${visit.body.data.id}/gate-rejection`, { reason: 'DETAILS_MISMATCH', gateId })
    expect(refused.body.data).toMatchObject({ status: 'REJECTED_AT_GATE', rejectionReason: 'DETAILS_MISMATCH', decidedBy: guardUserId })
    expect(refused.body.data.decidedAt).not.toBeNull()
    expect((await api.post(`/visits/${visit.body.data.id}/entry`, { gateId })).status).toBe(400)

    // A guard may turn away a visit the resident approved, but can never approve one themselves
    const approved = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ visitorPhone: '9844444444' }))
    await api.post(`/visits/${approved.body.data.id}/decision`, { decision: 'APPROVED' }, resident)
    const atGate = await api.post(`/visits/${approved.body.data.id}/gate-rejection`, { reason: 'SECURITY_CONCERN' })
    expect(atGate.body.data.status).toBe('REJECTED_AT_GATE')
    expect((await api.post(`/visits/${approved.body.data.id}/gate-rejection`, { reason: 'INVALID_PASS' })).status).toBe(400)
  })

  it('keeps a delivery at the gate without ever letting the courier in', async () => {
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    await api.post(`/visits/${visit.body.data.id}/decision`, { decision: 'LEAVE_AT_GATE' }, resident)

    const handover = await api.post(`/visits/${visit.body.data.id}/leave-at-gate`, { gateId, note: 'Left with security' })
    expect(handover.status).toBe(201)
    expect(handover.body.data.collectionCode).toMatch(/^\d{6}$/)
    expect(handover.body.data.receivedBy).toBe(guardUserId)

    // The courier did not come in, and nothing says they did
    const [after] = await db.select().from(visits).where(eq(visits.id, visit.body.data.id))
    expect(after!.status).toBe('LEAVE_AT_GATE')
    expect(after!.enteredAt).toBeNull()
    expect(after!.exitedAt).toBeNull()
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/inside`, guard)).body.data).toHaveLength(0)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/deliveries`, guard)).body.data).toHaveLength(1)

    // The resident acknowledges it, and only once
    const collected = await api.post(`/deliveries/${handover.body.data.id}/collection`, {}, resident)
    expect(collected.body.data).toMatchObject({ collectedBy: residentUserId, collectedByName: 'Riya Sharma' })
    expect(collected.body.data.collectedAt).not.toBeNull()
    expect((await api.post(`/deliveries/${handover.body.data.id}/collection`, {}, resident)).status).toBe(400)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/deliveries`, guard)).body.data).toHaveLength(0)
  })

  it('lets the gate confirm a collection only with the code and a name', async () => {
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    await api.post(`/visits/${visit.body.data.id}/decision`, { decision: 'LEAVE_AT_GATE' }, resident)
    const handover = await api.post(`/visits/${visit.body.data.id}/leave-at-gate`, { gateId })
    const id = handover.body.data.id

    expect((await api.post(`/deliveries/${id}/collection`, {})).status).toBe(400)
    expect((await api.post(`/deliveries/${id}/collection`, { code: '000000', collectedByName: 'Riya Sharma' })).status).toBe(400)

    // Someone from another flat cannot acknowledge it at all
    const other = await createFlat(TEST_SOCIETY_ID, '905')
    const neighbour = await createUser({ phone: '9811111114', email: null, role: 'RESIDENT' })
    await addResident(other.id, neighbour.id)
    expect((await api.post(`/deliveries/${id}/collection`, {}, await tokenFor(neighbour))).status).toBe(403)

    const atGate = await api.post(`/deliveries/${id}/collection`, {
      code: handover.body.data.collectionCode,
      collectedByName: 'Riya’s mother',
    })
    expect(atGate.body.data).toMatchObject({ collectedBy: guardUserId, collectedByName: 'Riya’s mother' })
  })

  it('does not keep a guest at the gate, only a delivery the resident asked to leave', async () => {
    const guest = await api.post(
      `/societies/${TEST_SOCIETY_ID}/visits`,
      visitBody({ purpose: 'GUEST', intendedResidentId: residentUserId }),
    )
    await api.post(`/visits/${guest.body.data.id}/decision`, { decision: 'APPROVED' }, resident)
    expect((await api.post(`/visits/${guest.body.data.id}/leave-at-gate`, { gateId })).status).toBe(400)

    // A delivery nobody has answered yet is not at the gate either
    const parcel = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ visitorPhone: '9844444445' }))
    expect((await api.post(`/visits/${parcel.body.data.id}/leave-at-gate`, { gateId })).status).toBe(400)
  })

  it('waits on the resident, then records entry and exit', async () => {
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    expect(visit.status).toBe(201)
    expect(visit.body.data.status).toBe('AWAITING_APPROVAL')

    // The resident sees it at the top of their own list
    const mine = await api.get('/me/visits', resident)
    expect(mine.body.data[0]).toMatchObject({ id: visit.body.data.id, status: 'AWAITING_APPROVAL' })

    const approved = await api.post(`/visits/${visit.body.data.id}/decision`, { decision: 'APPROVED' }, resident)
    expect(approved.body.data).toMatchObject({ status: 'APPROVED', decidedBy: residentUserId })

    // Deciding twice is refused, so two taps cannot both count
    expect((await api.post(`/visits/${visit.body.data.id}/decision`, { decision: 'DENIED' }, resident)).status).toBe(400)

    const entered = await api.post(`/visits/${visit.body.data.id}/entry`, { gateId })
    expect(entered.body.data.status).toBe('ENTERED')
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/inside`, guard)).body.data).toHaveLength(1)

    const left = await api.post(`/visits/${visit.body.data.id}/exit`, {})
    expect(left.body.data.status).toBe('CLOSED')
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/inside`, guard)).body.data).toHaveLength(0)
    expect((await api.post(`/visits/${visit.body.data.id}/exit`, {})).status).toBe(400)
  })

  it('will not let in a visit the resident denied or left at the gate', async () => {
    const denied = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    await api.post(`/visits/${denied.body.data.id}/decision`, { decision: 'DENIED', reason: 'Not expecting anyone' }, resident)
    expect((await api.post(`/visits/${denied.body.data.id}/entry`, {})).status).toBe(400)

    const parcel = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    await api.post(`/visits/${parcel.body.data.id}/decision`, { decision: 'LEAVE_AT_GATE' }, resident)
    expect((await api.post(`/visits/${parcel.body.data.id}/entry`, {})).status).toBe(400)
  })

  it('lets the guard decide when the flat does not answer, and fills in a returning visitor', async () => {
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    const decided = await api.post(`/visits/${visit.body.data.id}/decision`, { decision: 'APPROVED', reason: 'Intercom, no answer' })
    expect(decided.body.data.status).toBe('APPROVED')

    const known = await api.get(`/societies/${TEST_SOCIETY_ID}/visitor-lookup?phone=9833333333`, guard)
    expect(known.body.data).toMatchObject({ visitorName: 'Dev Courier', purpose: 'DELIVERY' })
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/visitor-lookup?phone=9999999999`, guard)).body.data).toBeNull()
  })

  it('offers the guard a flat picker naming who lives there', async () => {
    const directory = await api.get(`/societies/${TEST_SOCIETY_ID}/flat-directory`, guard)
    expect(directory.body.data).toEqual([{ id: flatId, label: 'A-101-101', residents: [{ id: residentUserId, name: 'Riya Sharma' }] }])
  })

  it('keeps every gate route inside the guard’s own society and behind its permission', async () => {
    expect((await request(app).get(`/api/v1/societies/${TEST_SOCIETY_ID}/visits`)).status).toBe(401)
    expect((await api.get(`/societies/${OTHER_SOCIETY_ID}/visits`, guard)).status).toBe(403)
    // A resident holds none of the gate permissions
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/visits`, resident)).status).toBe(403)
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody(), resident)).status).toBe(403)

    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    const stranger = await createUser({ phone: '9811111118', email: null, role: 'RESIDENT' })
    expect((await api.post(`/visits/${visit.body.data.id}/decision`, { decision: 'APPROVED' }, await tokenFor(stranger))).status).toBe(403)
  })
})

describe('staff at the gate', () => {
  async function seedHelp() {
    const [member] = await db
      .insert(staff)
      .values({ societyId: TEST_SOCIETY_ID, kind: 'DAILY_HELP', name: 'Sunita Devi', phone: '9876543220', passCode: 'CK-HELP01', workType: 'Maid' })
      .returning()
    await db.insert(staffFlats).values({ staffId: member!.id, flatId, timeWindow: '7-9 am' })
    return member!
  }

  it('reads the pass, records entry and exit, and tells the flat', async () => {
    const member = await seedHelp()
    const checked = await api.get(`/societies/${TEST_SOCIETY_ID}/staff-pass/CK-HELP01`, guard)
    expect(checked.body.data).toMatchObject({ valid: true, reason: null })
    expect(checked.body.data.staff.flatsServed[0].label).toBe('A-101-101')
    expect(checked.body.data.staff.idDocumentHash).toBeUndefined()

    await api.post(`/staff/${member.id}/entry`, { gateId })
    expect((await api.get('/me/daily-help', resident)).body.data[0]).toMatchObject({ name: 'Sunita Devi', inside: true, timeWindow: '7-9 am' })
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/inside`, guard)).body.data[0]).toMatchObject({ kind: 'STAFF', flat: 'A-101-101' })

    // Entering twice without an exit is refused by the one-open-row index, so the list cannot
    // show one person twice however many guards tap at once
    expect((await api.post(`/staff/${member.id}/entry`, {})).status).toBe(409)
    await api.post(`/staff/${member.id}/exit`, {})
    expect((await api.get('/me/daily-help', resident)).body.data[0].inside).toBe(false)
    expect((await api.post(`/staff/${member.id}/exit`, {})).status).toBe(400)
  })

  it('refuses an expired or cancelled staff pass', async () => {
    const member = await seedHelp()
    await db.update(staff).set({ passValidFrom: '2024-01-01', passValidUntil: '2024-01-02' }).where(eq(staff.id, member.id))
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff-pass/CK-HELP01`, guard)).body.data).toMatchObject({
      valid: false,
      reason: 'This pass expired',
    })

    await db.update(staff).set({ passValidUntil: null, status: 'INACTIVE' }).where(eq(staff.id, member.id))
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff-pass/CK-HELP01`, guard)).body.data.reason).toBe('This pass was cancelled')
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff-pass/CK-NOPE`, guard)).body.data.staff).toBeNull()
  })

  it('lets the flat mark the day off, but not a flat the staff member does not serve', async () => {
    const member = await seedHelp()
    const marked = await api.post(`/staff/${member.id}/leave`, {}, resident)
    expect(marked.status).toBe(201)
    expect((await api.get('/me/daily-help', resident)).body.data[0].onLeaveToday).toBe(true)

    const stranger = await createUser({ phone: '9811111117', email: null, role: 'RESIDENT' })
    expect((await api.post(`/staff/${member.id}/leave`, {}, await tokenFor(stranger))).status).toBe(403)
    // The office may always look
    expect((await api.get(`/staff/${member.id}/attendance`, admin)).status).toBe(200)
  })
})

describe('vehicles and requests to the office', () => {
  it('registers a vehicle the gate can look up, and refuses a duplicate plate', async () => {
    const added = await api.post(`/flats/${flatId}/vehicles`, { number: 'MH 12 AB 3344', vehicleType: 'CAR', makeColour: 'Swift, white' }, resident)
    expect(added.status).toBe(201)
    expect((await api.post(`/flats/${flatId}/vehicles`, { number: 'mh 12 ab 3344' }, resident)).status).toBe(409)

    const found = await api.get(`/societies/${TEST_SOCIETY_ID}/vehicle-lookup/MH%2012%20AB%203344`, guard)
    expect(found.body.data.flat.label).toBe('A-101-101')

    await api.del(`/vehicles/${added.body.data.id}`, resident)
    expect((await api.get('/me/vehicles', resident)).body.data).toEqual([])
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/vehicle-lookup/MH%2012%20AB%203344`, guard)).body.data).toBeNull()
  })

  it('sends a household request to the office and records the decision', async () => {
    const asked = await api.post(
      '/me/access-requests',
      { flatId, kind: 'HOUSEHOLD_MEMBER', name: 'Priya Sharma', phone: '9876543215', relationship: 'Spouse', accessLevel: 'VIEW_ONLY' },
      resident,
    )
    expect(asked.status).toBe(201)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/access-requests?status=PENDING`, admin)).body.data[0]).toMatchObject({
      name: 'Priya Sharma',
      flat: { label: 'A-101-101' },
    })

    const decided = await api.post(`/access-requests/${asked.body.data.id}/decision`, { status: 'APPROVED' }, admin)
    expect(decided.body.data.status).toBe('APPROVED')
    expect((await api.post(`/access-requests/${asked.body.data.id}/decision`, { status: 'REJECTED' }, admin)).status).toBe(400)
    // A resident may never decide their own request
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/access-requests`, resident)).status).toBe(403)
  })
})

describe('staff movement and verification', () => {
  async function seedStaff(overrides: Record<string, unknown> = {}) {
    const [member] = await db
      .insert(staff)
      .values({
        societyId: TEST_SOCIETY_ID,
        kind: 'DAILY_HELP',
        name: 'Ahmed Khan',
        phone: '9876543230',
        passCode: 'CK-MOVE01',
        workType: 'Housekeeping',
        ...overrides,
      })
      .returning()
    await db.insert(staffFlats).values({ staffId: member!.id, flatId })
    return member!
  }

  // AC1, AC2: the guard is shown who this is and whether entry can be recorded
  it('returns only what the gate needs to verify a staff member', async () => {
    const member = await seedStaff()
    const check = await api.get(`/staff/${member.id}/verification`, guard)

    expect(check.status).toBe(200)
    expect(check.body.data).toMatchObject({
      staffId: member.id,
      name: 'Ahmed Khan',
      staffType: 'Housekeeping',
      active: true,
      currentlyInside: false,
      movementState: 'NOT_INSIDE',
      blockedReason: null,
    })
    expect(check.body.data.flatsServed[0].label).toBe('A-101-101')
    // Identity is never served, only whether it is on file
    expect(check.body.data.idDocumentHash).toBeUndefined()
    expect((await api.get(`/staff/${crypto.randomUUID()}/verification`, guard)).status).toBe(404)
  })

  // AC3: an inactive profile cannot produce an entry
  it('refuses entry for an inactive staff member and says why', async () => {
    const member = await seedStaff({ status: 'INACTIVE' })
    expect((await api.get(`/staff/${member.id}/verification`, guard)).body.data).toMatchObject({
      active: false,
      blockedReason: 'STAFF_INACTIVE',
    })

    const entry = await api.post(`/staff/${member.id}/entry`, { gateId })
    expect(entry.status).toBe(400)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff-inside`, guard)).body.data).toEqual([])
  })

  // AC4, AC26: another society's staff member is not reachable at this gate
  it('keeps staff movement inside the society', async () => {
    await db.insert(societies).values({ id: OTHER_SOCIETY_ID, name: 'Other Society' })
    const [outsider] = await db
      .insert(staff)
      .values({ societyId: OTHER_SOCIETY_ID, kind: 'DAILY_HELP', name: 'Other Help', phone: '9876543231', passCode: 'CK-OTHER1' })
      .returning()

    expect((await api.get(`/staff/${outsider!.id}/verification`, guard)).status).toBe(403)
    expect((await api.post(`/staff/${outsider!.id}/entry`, { gateId })).status).toBe(403)
    expect((await api.get(`/societies/${OTHER_SOCIETY_ID}/staff-inside`, guard)).status).toBe(403)
  })

  // AC5, AC7, AC12: one entry, one exit, both timestamped by the server
  it('records an entry and an exit with the server’s own timestamps', async () => {
    const member = await seedStaff()
    const before = Date.now()
    const entry = await api.post(`/staff/${member.id}/entry`, { gateId })

    expect(entry.status).toBe(201)
    expect(new Date(entry.body.data.enteredAt).getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(entry.body.data.exitedAt).toBeNull()
    expect((await api.get(`/staff/${member.id}/verification`, guard)).body.data).toMatchObject({
      currentlyInside: true,
      movementState: 'ENTERED',
      blockedReason: 'ALREADY_INSIDE',
    })

    const insideNow = await api.get(`/societies/${TEST_SOCIETY_ID}/staff-inside`, guard)
    expect(insideNow.body.data).toHaveLength(1)
    expect(insideNow.body.data[0]).toMatchObject({ name: 'Ahmed Khan', staffType: 'Housekeeping', gateName: 'Main gate', flats: ['A-101-101'] })

    const exit = await api.post(`/staff/${member.id}/exit`, { gateId })
    expect(exit.status).toBe(200)
    expect(exit.body.data.exitedAt).not.toBeNull()
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff-inside`, guard)).body.data).toEqual([])
  })

  // AC8: no exit without a matching entry
  it('refuses an exit, and a second exit, when the staff member is not inside', async () => {
    const member = await seedStaff()
    expect((await api.post(`/staff/${member.id}/exit`, {})).status).toBe(400)

    await api.post(`/staff/${member.id}/entry`, {})
    expect((await api.post(`/staff/${member.id}/exit`, {})).status).toBe(200)
    expect((await api.post(`/staff/${member.id}/exit`, {})).status).toBe(400)
  })

  // AC10: the same tap, retried, is answered rather than repeated
  it('answers a retried entry or exit with the movement it already recorded', async () => {
    const member = await seedStaff()
    const first = await api.post(`/staff/${member.id}/entry`, { gateId, idempotencyKey: 'tap-entry-0001' })
    const retry = await api.post(`/staff/${member.id}/entry`, { gateId, idempotencyKey: 'tap-entry-0001' })

    expect(retry.status).toBe(201)
    expect(retry.body.data.id).toBe(first.body.data.id)
    expect(retry.body.data.enteredAt).toBe(first.body.data.enteredAt)

    const out = await api.post(`/staff/${member.id}/exit`, { idempotencyKey: 'tap-exit-0001' })
    const outAgain = await api.post(`/staff/${member.id}/exit`, { idempotencyKey: 'tap-exit-0001' })
    expect(outAgain.status).toBe(200)
    expect(outAgain.body.data.exitedAt).toBe(out.body.data.exitedAt)

    // A different request id after the exit is a fresh entry, which is a real second visit
    const second = await api.post(`/staff/${member.id}/entry`, { idempotencyKey: 'tap-entry-0002' })
    expect(second.body.data.id).not.toBe(first.body.data.id)
  })

  // AC6, AC11: two guards, one entry
  it('lets only one of two simultaneous entries through', async () => {
    const member = await seedStaff()
    const otherGuardUser = await createUser({ phone: '9000000009', email: null, role: 'GUARD' })
    const otherGuard = await tokenFor(otherGuardUser)

    const results = await Promise.all([
      api.post(`/staff/${member.id}/entry`, { gateId }),
      api.post(`/staff/${member.id}/entry`, { gateId }, otherGuard),
    ])
    expect(results.filter((result) => result.status === 201)).toHaveLength(1)
    expect(results.filter((result) => result.status === 409)).toHaveLength(1)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff-inside`, guard)).body.data).toHaveLength(1)
  })

  // AC9: a refusal is a record of its own, with a reason
  it('records a refused entry with its reason and creates no entry', async () => {
    const member = await seedStaff()
    const rejected = await api.post(`/staff/${member.id}/movement/entry-rejection`, { gateId, reason: 'VERIFICATION_FAILED' })

    expect(rejected.status).toBe(201)
    expect(rejected.body.data).toMatchObject({ reason: 'VERIFICATION_FAILED', note: null })
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff-inside`, guard)).body.data).toEqual([])
    expect((await api.get(`/staff/${member.id}/verification`, guard)).body.data.currentlyInside).toBe(false)

    // OTHER must say what happened, and a retry of the same tap records one refusal
    expect((await api.post(`/staff/${member.id}/movement/entry-rejection`, { reason: 'OTHER' })).status).toBe(422)
    const other = await api.post(`/staff/${member.id}/movement/entry-rejection`, { reason: 'OTHER', note: 'Could not match the photo', idempotencyKey: 'tap-reject-01' })
    const otherAgain = await api.post(`/staff/${member.id}/movement/entry-rejection`, { reason: 'OTHER', note: 'Could not match the photo', idempotencyKey: 'tap-reject-01' })
    expect(otherAgain.body.data.id).toBe(other.body.data.id)
  })

  // AC13, AC23, AC24: history survives deactivation and filters down
  it('reads back entries, exits and refusals, filtered, and keeps them after deactivation', async () => {
    const member = await seedStaff()
    await api.post(`/staff/${member.id}/entry`, { gateId })
    await api.post(`/staff/${member.id}/exit`, {})
    await api.post(`/staff/${member.id}/movement/entry-rejection`, { gateId, reason: 'SECURITY_CONCERN' })

    const all = await api.get(`/societies/${TEST_SOCIETY_ID}/staff-movements`, admin)
    expect(all.status).toBe(200)
    expect(all.body.data.total).toBe(3)
    expect(all.body.data.movements.map((row: { eventType: string }) => row.eventType).sort()).toEqual(['ENTRY', 'ENTRY_REJECTED', 'EXIT'])
    expect(all.body.data.movements.every((row: { performedBy: string | null }) => row.performedBy !== null)).toBe(true)

    const refusals = await api.get(`/societies/${TEST_SOCIETY_ID}/staff-movements?verificationStatus=REJECTED`, admin)
    expect(refusals.body.data.movements).toHaveLength(1)
    expect(refusals.body.data.movements[0]).toMatchObject({ eventType: 'ENTRY_REJECTED', rejectionReason: 'SECURITY_CONCERN', staffType: 'Housekeeping' })

    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff-movements?eventType=EXIT`, admin)).body.data.total).toBe(1)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff-movements?staffType=Housekeeping`, admin)).body.data.total).toBe(3)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff-movements?dateFrom=2020-01-01&dateTo=2020-01-02`, admin)).body.data.total).toBe(0)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff-movements?limit=1`, admin)).body.data.movements).toHaveLength(1)

    // The profile goes inactive; what the gate recorded stays
    await db.update(staff).set({ status: 'INACTIVE' }).where(eq(staff.id, member.id))
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff-movements`, admin)).body.data.total).toBe(3)
  })

  // AC14, AC25: a resident records nothing and reads no one else's movement
  it('refuses staff movement and its history to a resident', async () => {
    const member = await seedStaff()
    expect((await api.post(`/staff/${member.id}/entry`, { gateId }, resident)).status).toBe(403)
    expect((await api.post(`/staff/${member.id}/movement/entry-rejection`, { reason: 'STAFF_INACTIVE' }, resident)).status).toBe(403)
    expect((await api.get(`/staff/${member.id}/verification`, resident)).status).toBe(403)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/staff-movements`, resident)).status).toBe(403)
  })

  // AC15, test cases 27 and 28: the movement raises an event for SMB-52 to deliver, and the
  // delivery is a separate row, so a channel failing later cannot undo what the gate recorded
  it('hands a successful entry and exit to the notification outbox', async () => {
    const member = await seedStaff()
    await api.post(`/staff/${member.id}/entry`, { gateId })
    await api.post(`/staff/${member.id}/exit`, { gateId })

    const queued = await db.select().from(notificationOutbox).where(eq(notificationOutbox.entityType, 'staff'))
    expect(queued.map((row) => row.eventType).sort()).toEqual(['STAFF_ENTERED', 'STAFF_EXITED'])
    expect(queued[0]).toMatchObject({ societyId: TEST_SOCIETY_ID, payload: { name: 'Ahmed Khan', flat: 'A-101-101' } })
    // The resident of the flat they serve is told; the guard who recorded it is not
    expect(queued[0]!.recipientIds).toEqual([residentUserId])
    // Nothing was delivered inside the movement: that is the dispatcher's own, later, work
    expect(queued.every((row) => row.processedAt === null)).toBe(true)
  })

  // Test case 16: a guard posted to one gate records nothing at another
  it('refuses a movement at a gate the guard is not posted to', async () => {
    const member = await seedStaff()
    const [other] = await db.insert(gates).values({ societyId: TEST_SOCIETY_ID, code: 'BACK', name: 'Back gate' }).returning()
    await db.insert(guardGateAssignments).values({ guardUserId, gateId: other!.id, assignedBy: guardUserId })

    const denied = await api.post(`/staff/${member.id}/entry`, { gateId })
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('GATE_ACCESS_DENIED')
    expect((await api.post(`/staff/${member.id}/entry`, { gateId: other!.id })).status).toBe(201)
  })

  // Test case 16: a gate from another society, or one taken out of use, is not a valid place
  it('refuses a movement at a gate that is not this society’s or not in use', async () => {
    const member = await seedStaff()
    expect((await api.post(`/staff/${member.id}/entry`, { gateId: crypto.randomUUID() })).status).toBe(404)

    await db.update(gates).set({ status: 'INACTIVE' }).where(eq(gates.id, gateId))
    expect((await api.post(`/staff/${member.id}/entry`, { gateId })).status).toBe(400)
    // Without a gate the entry still records; not every society configures them
    expect((await api.post(`/staff/${member.id}/entry`, {})).status).toBe(201)
  })
})

describe('the gate log', () => {
  it('records the day’s entries and exits, with the numbers a shift is asked for', async () => {
    // One visitor in and out again, one still inside, and one turned away at the gate
    const inAndOut = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    await api.post(`/visits/${inAndOut.body.data.id}/decision`, { decision: 'APPROVED' }, resident)
    await api.post(`/visits/${inAndOut.body.data.id}/entry`, { gateId })
    await api.post(`/visits/${inAndOut.body.data.id}/exit`, {})

    const staying = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ visitorPhone: '9844444444', purpose: 'GUEST', visitorName: 'Riya Guest', intendedResidentId: residentUserId }))
    await api.post(`/visits/${staying.body.data.id}/decision`, { decision: 'APPROVED' }, resident)
    await api.post(`/visits/${staying.body.data.id}/entry`, {})

    const refused = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ visitorPhone: '9855555555' }))
    await api.post(`/visits/${refused.body.data.id}/decision`, { decision: 'DENIED', reason: 'Not expected' }, resident)

    const log = await api.get(`/societies/${TEST_SOCIETY_ID}/gate-log`, guard)
    expect(log.status).toBe(200)
    expect(log.body.data.on).toBe(today())
    expect(log.body.data.metrics).toMatchObject({
      entries: 2,
      exits: 1,
      stillInside: 1,
      openOvernight: 0,
      turnedAway: 1,
      byType: { DELIVERY: 1, GUEST: 1 },
    })
    expect(log.body.data.metrics.averageStayMinutes).toBeGreaterThanOrEqual(0)
    expect(log.body.data.metrics.busiestHour).toMatchObject({ entries: 2 })
    // An entry and its exit are two lines, newest first
    const movements: { direction: string; at: string; name: string; flat: string; gateName: string | null }[] = log.body.data.movements
    expect(movements).toHaveLength(3)
    expect([...movements].sort((a, b) => b.at.localeCompare(a.at)).map((row) => row.at)).toEqual(movements.map((row) => row.at))
    expect(movements.filter((row) => row.name === 'Dev Courier').map((row) => row.direction).sort()).toEqual(['IN', 'OUT'])
    expect(movements.find((row) => row.direction === 'OUT')).toMatchObject({ flat: 'A-101-101', gateName: 'Main gate' })
  })

  it('counts a staff member through the gate on the same day, and nothing on an empty day', async () => {
    const [member] = await db
      .insert(staff)
      .values({ societyId: TEST_SOCIETY_ID, kind: 'DAILY_HELP', name: 'Sunita Devi', phone: '9876543221', passCode: 'CK-HELP02', workType: 'Maid' })
      .returning()
    await db.insert(staffFlats).values({ staffId: member!.id, flatId })
    await api.post(`/staff/${member!.id}/entry`, { gateId })

    const log = await api.get(`/societies/${TEST_SOCIETY_ID}/gate-log`, guard)
    expect(log.body.data.metrics).toMatchObject({ entries: 1, exits: 0, stillInside: 1, byType: { STAFF: 1 } })
    expect(log.body.data.movements[0]).toMatchObject({ kind: 'STAFF', name: 'Sunita Devi', flat: 'A-101-101' })

    // A day with no movements still answers, and the staff member inside is not counted into it
    const quiet = await api.get(`/societies/${TEST_SOCIETY_ID}/gate-log?on=2020-02-02`, guard)
    expect(quiet.body.data.metrics).toMatchObject({ entries: 0, exits: 0, averageStayMinutes: null, busiestHour: null })
    expect(quiet.body.data.movements).toEqual([])
  })

  it('is refused to a resident, and to a guard from another society', async () => {
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/gate-log`, resident)).status).toBe(403)
    expect((await api.get(`/societies/${OTHER_SOCIETY_ID}/gate-log`, guard)).status).toBe(403)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/gate-log?on=not-a-date`, guard)).status).toBe(422)
  })
})

describe('the guard’s overview', () => {
  it('counts what is waiting, who is inside and how many passes are expected today', async () => {
    await api.post(`/flats/${flatId}/passes`, passBody(), resident)
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    const second = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ visitorPhone: '9844444444' }))
    await api.post(`/visits/${second.body.data.id}/decision`, { decision: 'APPROVED' }, resident)
    await api.post(`/visits/${second.body.data.id}/entry`, {})

    const summary = await api.get(`/societies/${TEST_SOCIETY_ID}/gate-summary`, guard)
    expect(summary.body.data).toMatchObject({ waiting: 1, inside: 1, visitorsInside: 1, staffInside: 0, today: 2, expected: 1 })
    expect(visit.body.data.status).toBe('AWAITING_APPROVAL')
  })
})
