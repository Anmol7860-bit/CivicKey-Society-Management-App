import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import {
  auditLogs,
  gates,
  notificationDeliveries,
  notificationOutbox,
  notifications,
  pushSubscriptions,
  storedFiles,
  visits,
} from '../../db/schema.js'
import { addResident, createFlat, createPhoto, createUser, TEST_SOCIETY_ID, signTestToken } from '../../test/helpers.js'
import { deliverDue, fanOutPending, nextAttempt, runDispatcherOnce } from './dispatcher.js'
import { runJobsOnce } from './jobs.js'
import { enqueueNotification } from './outbox.service.js'

const app = createApp()

let guard: string
let guardUserId: string
let resident: string
let residentUserId: string
let flatId: string
let gateId: string
let photoId: string

const tokenFor = (user: { id: string; role: 'ADMIN' | 'RESIDENT' | 'GUARD' }) =>
  signTestToken({ userId: user.id, role: user.role, societyId: TEST_SOCIETY_ID }).then((t) => `Bearer ${t}`)

const api = {
  get: (path: string, token: string) => request(app).get(`/api/v1${path}`).set('Authorization', token),
  post: (path: string, body: object = {}, token = guard) => request(app).post(`/api/v1${path}`).set('Authorization', token).send(body),
  del: (path: string, token: string) => request(app).delete(`/api/v1${path}`).set('Authorization', token),
}

const visitBody = (overrides: object = {}) => ({
  flatId,
  gateId,
  visitorName: 'Dev Courier',
  visitorPhone: '9833333333',
  purpose: 'DELIVERY' as const,
  people: 1,
  photoReference: photoId,
  expectedDate: new Date().toISOString().slice(0, 10),
  expectedTime: '10:30',
  ...overrides,
})

const deliveriesFor = (notificationId: string) =>
  db.select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, notificationId))

beforeEach(async () => {
  photoId = await createPhoto()
  const guardUser = await createUser({ phone: '9000000002', email: null, role: 'GUARD' })
  guardUserId = guardUser.id
  guard = await tokenFor(guardUser)
  const residentUser = await createUser({ phone: '9876543210', email: 'riya@example.com', role: 'RESIDENT' })
  residentUserId = residentUser.id
  resident = await tokenFor(residentUser)
  flatId = (await createFlat()).id
  await addResident(flatId, residentUser.id)
  const [gate] = await db.insert(gates).values({ societyId: TEST_SOCIETY_ID, code: 'MAIN', name: 'Main gate' }).returning()
  gateId = gate!.id
})

describe('the outbox', () => {
  it('writes the event in the same transaction as the visit it describes', async () => {
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    expect(visit.status).toBe(201)

    const [event] = await db.select().from(notificationOutbox).where(eq(notificationOutbox.entityId, visit.body.data.id))
    expect(event).toMatchObject({ eventType: 'VISITOR_WAITING_APPROVAL', status: 'PENDING', entityType: 'visit' })
    // The resident who holds the flat is the one asked
    expect(event!.recipientIds).toEqual([residentUserId])
  })

  it('tells the gate, not a resident, when the flat has nobody who can answer', async () => {
    const empty = await createFlat(TEST_SOCIETY_ID, '902')
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody({ flatId: empty.id }))

    const [event] = await db.select().from(notificationOutbox).where(eq(notificationOutbox.entityId, visit.body.data.id))
    expect(event).toMatchObject({ eventType: 'VISITOR_ESCALATED_TO_GATE' })
    expect(event!.recipientIds).toEqual([guardUserId])
  })
})

describe('the dispatcher', () => {
  it('fans one event out to an in-app record and a row per channel', async () => {
    await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())

    expect(await fanOutPending()).toMatchObject({ fannedOut: 1 })

    const [record] = await db.select().from(notifications).where(eq(notifications.userId, residentUserId))
    expect(record).toMatchObject({ eventType: 'VISITOR_WAITING_APPROVAL', readAt: null })

    const byChannel = Object.fromEntries((await deliveriesFor(record!.id)).map((row) => [row.channel, row.status]))
    expect(byChannel.IN_APP).toBe('SENT')
    // No subscription, and a visitor at the gate is not one of the three events that go by email
    expect(byChannel.PUSH).toBe('SKIPPED')
    expect(byChannel.EMAIL).toBe('SKIPPED')
    expect(byChannel.SOCKET).toBe('PENDING')

    const [event] = await db.select().from(notificationOutbox)
    expect(event).toMatchObject({ status: 'DONE' })
  })

  it('does not tell the same person twice when a row is fanned out again', async () => {
    await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    await runDispatcherOnce()
    // Put it back as if the first pass had died after writing the records
    await db.update(notificationOutbox).set({ status: 'PENDING', claimedAt: null })

    await runDispatcherOnce()

    expect(await db.$count(notifications, eq(notifications.userId, residentUserId))).toBe(1)
  })

  it('sends a push only to someone with a live subscription', async () => {
    await db.insert(pushSubscriptions).values({ userId: residentUserId, endpoint: 'https://push.example/abc', p256dh: 'key', auth: 'secret' })
    await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())

    await fanOutPending()

    const [record] = await db.select().from(notifications).where(eq(notifications.userId, residentUserId))
    const push = (await deliveriesFor(record!.id)).find((row) => row.channel === 'PUSH')
    // Queued, because this person has a live subscription to push to
    expect(push!.status).toBe('PENDING')

    // Without VAPID keys the attempt is skipped rather than failed, so a local run stays clean
    await deliverDue()
    const after = (await deliveriesFor(record!.id)).find((row) => row.channel === 'PUSH')
    expect(after!.status).toBe('SKIPPED')
  })

  it('queues an email only for the three events the baseline allows', async () => {
    await enqueueNotification(db, {
      societyId: TEST_SOCIETY_ID,
      eventType: 'RECEIPT_READY',
      entityType: 'receipt',
      recipientIds: [residentUserId],
      payload: { flat: 'A-101' },
    })

    await fanOutPending()

    const [record] = await db.select().from(notifications).where(eq(notifications.eventType, 'RECEIPT_READY'))
    const email = (await deliveriesFor(record!.id)).find((row) => row.channel === 'EMAIL')
    expect(email!.status).toBe('PENDING')

    // A visitor at the gate is urgent and belongs on the phone, so it is never queued for email
    await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    await fanOutPending()
    const [gateRecord] = await db.select().from(notifications).where(eq(notifications.eventType, 'VISITOR_WAITING_APPROVAL'))
    const gateEmail = (await deliveriesFor(gateRecord!.id)).find((row) => row.channel === 'EMAIL')
    expect(gateEmail!.status).toBe('SKIPPED')
  })

  it('leaves nothing to deliver for an event with no recipients', async () => {
    await enqueueNotification(db, {
      societyId: TEST_SOCIETY_ID,
      eventType: 'INVOICE_GENERATED',
      entityType: 'invoice',
      recipientIds: [],
    })

    await runDispatcherOnce()

    expect(await db.$count(notifications)).toBe(0)
    const [event] = await db.select().from(notificationOutbox)
    expect(event!.status).toBe('DONE')
  })

  it('backs a failed channel off along the fixed ladder, then gives up', async () => {
    // 30 seconds, then 2 minutes, 10 minutes and an hour; the fifth attempt is the last
    expect([0, 1, 2, 3].map((done) => nextAttempt(done).waitSeconds)).toEqual([30, 120, 600, 3600])
    expect([0, 1, 2, 3].map((done) => nextAttempt(done).dead)).toEqual([false, false, false, false])
    expect(nextAttempt(4)).toMatchObject({ attempts: 5, dead: true })
    // A provider that refused the message will refuse it again, so it is not retried at all
    expect(nextAttempt(0, true)).toMatchObject({ attempts: 1, dead: true })
  })
})

describe('scheduled jobs', () => {
  it('deletes a visitor photograph once the retention period has passed, and keeps the visit', async () => {
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    const id = visit.body.data.id
    await api.post(`/visits/${id}/decision`, { decision: 'APPROVED' }, resident)
    await api.post(`/visits/${id}/entry`, {})
    await api.post(`/visits/${id}/exit`, {})

    // A photo still inside the window is left alone
    await runJobsOnce()
    expect((await db.select().from(visits).where(eq(visits.id, id)))[0]!.photoReference).toBe(photoId)

    // The clock is a column here too: ninety days back puts it past the default
    const longAgo = new Date(Date.now() - 91 * 24 * 3600_000)
    await db.update(visits).set({ updatedAt: longAgo }).where(eq(visits.id, id))
    expect((await runJobsOnce()).photos).toBe(1)

    const [kept] = await db.select().from(visits).where(eq(visits.id, id))
    expect(kept!.photoReference).toBeNull()
    // The visit, its times and its history stay; only the image is gone
    expect(kept!.enteredAt).not.toBeNull()
    expect(kept!.exitedAt).not.toBeNull()
    expect((await db.select().from(storedFiles).where(eq(storedFiles.id, photoId)))).toHaveLength(0)
    const trail = await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'VISIT_PHOTO_DELETED'))
    expect(trail).toHaveLength(1)
  })

  it('reminds the approver once, a minute in', async () => {
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    const id = visit.body.data.id
    // The deadline is a column, so the test moves the clock by moving the column
    await db.update(visits).set({ reminderAt: new Date(Date.now() - 1000) }).where(eq(visits.id, id))

    expect(await runJobsOnce()).toMatchObject({ reminders: 1 })
    expect(await runJobsOnce()).toMatchObject({ reminders: 0 })

    const reminders = await db.select().from(notificationOutbox).where(eq(notificationOutbox.eventType, 'VISITOR_APPROVAL_REMINDER'))
    expect(reminders).toHaveLength(1)
    expect(reminders[0]!.recipientIds).toEqual([residentUserId])
  })

  it('hands an unanswered visit to the guard after three minutes', async () => {
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    const id = visit.body.data.id
    await db.update(visits).set({ escalateAt: new Date(Date.now() - 1000) }).where(eq(visits.id, id))

    expect(await runJobsOnce()).toMatchObject({ escalations: 1 })

    const [after] = await db.select().from(visits).where(eq(visits.id, id))
    expect(after!.status).toBe('AWAITING_MANUAL')
    // Only the update that actually moved it returns it, so a second pass escalates nothing
    expect(await runJobsOnce()).toMatchObject({ escalations: 0 })
    const escalations = await db.select().from(notificationOutbox).where(eq(notificationOutbox.eventType, 'VISITOR_ESCALATED_TO_GATE'))
    expect(escalations).toHaveLength(1)
    expect(escalations[0]!.recipientIds).toEqual([guardUserId])
  })

  it('leaves an answered visit alone once its deadline passes', async () => {
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    const id = visit.body.data.id
    await api.post(`/visits/${id}/decision`, { decision: 'APPROVED' }, resident)
    await db.update(visits).set({ escalateAt: new Date(Date.now() - 1000), reminderAt: new Date(Date.now() - 1000) }).where(eq(visits.id, id))

    expect(await runJobsOnce()).toMatchObject({ escalations: 0, reminders: 0 })
    const [after] = await db.select().from(visits).where(eq(visits.id, id))
    expect(after!.status).toBe('APPROVED')
  })
})

describe('the guard deciding an escalated visit', () => {
  it('takes the decision with a reason, and refuses it without one', async () => {
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    const id = visit.body.data.id
    await db.update(visits).set({ status: 'AWAITING_MANUAL' }).where(eq(visits.id, id))

    const noReason = await api.post(`/visits/${id}/decision`, { decision: 'APPROVED' })
    expect(noReason.status).toBe(400)

    const decided = await api.post(`/visits/${id}/decision`, { decision: 'APPROVED', reason: 'Resident reached by phone' })
    expect(decided.status).toBe(200)
    expect(decided.body.data).toMatchObject({ status: 'APPROVED', decisionReason: 'Resident reached by phone' })
  })

  it('does not let a resident decide a visit that has already escalated', async () => {
    const visit = await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    const id = visit.body.data.id
    await db.update(visits).set({ status: 'AWAITING_MANUAL' }).where(eq(visits.id, id))

    expect((await api.post(`/visits/${id}/decision`, { decision: 'APPROVED' }, resident)).status).toBe(400)
  })
})

describe('reading notifications', () => {
  it('shows a person their own, and marks them read', async () => {
    await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    await runDispatcherOnce()

    const mine = await api.get('/notifications', resident)
    expect(mine.status).toBe(200)
    expect(mine.body.data.unread).toBe(1)
    expect(mine.body.data.items[0]).toMatchObject({ eventType: 'VISITOR_WAITING_APPROVAL', readAt: null })
    expect(mine.body.data.items[0].title).toBe('A visitor is at the gate')

    expect((await api.post('/notifications/read', {}, resident)).body.data).toEqual({ marked: 1 })
    expect((await api.get('/notifications', resident)).body.data.unread).toBe(0)
  })

  it("never shows one person another person's notifications", async () => {
    await api.post(`/societies/${TEST_SOCIETY_ID}/visits`, visitBody())
    await runDispatcherOnce()

    const theirs = await api.get('/notifications', guard)
    expect(theirs.body.data.items).toHaveLength(0)

    // Marking by id only works on your own
    const [record] = await db.select().from(notifications).where(eq(notifications.userId, residentUserId))
    expect((await api.post(`/notifications/${record!.id}/read`, {}, guard)).body.data).toEqual({ marked: 0 })
    const [untouched] = await db.select().from(notifications).where(eq(notifications.id, record!.id))
    expect(untouched!.readAt).toBeNull()
  })

  it('stores a push subscription once per browser, and stops using it on request', async () => {
    const subscription = { endpoint: 'https://push.example/xyz', keys: { p256dh: 'key', auth: 'secret' } }
    expect((await api.post('/notifications/push', subscription, resident)).status).toBe(201)
    // The same browser again is the same row, not a second one
    await api.post('/notifications/push', subscription, resident)
    expect(await db.$count(pushSubscriptions)).toBe(1)

    expect((await api.del('/notifications/push', resident)).body.data).toEqual({ removed: 1 })
    const [row] = await db.select().from(pushSubscriptions)
    expect(row!.isActive).toBe(false)
  })

  it('needs a signed-in person', async () => {
    expect((await request(app).get('/api/v1/notifications')).status).toBe(401)
  })
})
