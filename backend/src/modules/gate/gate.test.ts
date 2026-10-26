import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { gates, societies, staff, staffFlats, visitorPasses } from '../../db/schema.js'
import { addResident, createFlat, createUser, grantPermissions, TEST_SOCIETY_ID } from '../../test/helpers.js'
import { signAccessToken } from '../auth/tokens.js'

const app = createApp()
const OTHER_SOCIETY_ID = '33333333-3333-4333-8333-333333333333'

let guard: string
let resident: string
let admin: string
let flatId: string
let gateId: string
let residentUserId: string

function tokenFor(user: { id: string; role: 'ADMIN' | 'RESIDENT' | 'GUARD' }) {
  return signAccessToken({ userId: user.id, sessionId: 's1', role: user.role, societyId: TEST_SOCIETY_ID }).then((token) => `Bearer ${token}`)
}

const api = {
  get: (path: string, token: string) => request(app).get(`/api/v1${path}`).set('Authorization', token),
  post: (path: string, body: object = {}, token = guard) => request(app).post(`/api/v1${path}`).set('Authorization', token).send(body),
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

const visitBody = (overrides: object = {}) => ({
  flatId,
  gateId,
  visitorName: 'Dev Courier',
  visitorPhone: '9833333333',
  purpose: 'DELIVERY' as const,
  people: 1,
  ...overrides,
})

beforeEach(async () => {
  const guardUser = await createUser({ phone: '9000000002', email: null, role: 'GUARD' })
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

  it('offers the guard a flat picker with first names only', async () => {
    const directory = await api.get(`/societies/${TEST_SOCIETY_ID}/flat-directory`, guard)
    expect(directory.body.data).toEqual([{ id: flatId, label: 'A-101-101', residents: ['Riya'] }])
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

    const staying = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ visitorPhone: '9844444444', purpose: 'GUEST', visitorName: 'Riya Guest' }))
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
