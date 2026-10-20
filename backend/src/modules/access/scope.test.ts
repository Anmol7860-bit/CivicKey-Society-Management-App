import express from 'express'
import type { PgInsertValue } from 'drizzle-orm/pg-core'
import request from 'supertest'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { auditLogs, flatResidents } from '../../db/schema.js'
import { errorHandler } from '../../middleware/errorHandler.js'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireFlatAccess } from '../../middleware/requireFlatAccess.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { createFlat, createUser, grantPermissions, TEST_SOCIETY_ID } from '../../test/helpers.js'
import { signAccessToken } from '../auth/tokens.js'
import type { AdminPermission } from './permissions.js'
import { assertState, requireRecord } from './scope.js'

const OTHER_SOCIETY_ID = '33333333-3333-4333-8333-333333333333'
const ok: express.RequestHandler = (_req, res) => {
  res.json({ data: 'ok' })
}

// Stand-ins for flat-scoped operations until the real endpoints exist
const app = express()
app.get('/flats/:flatId/bills', requireAuth, requirePermission('BILL_VIEW_OWN'), requireFlatAccess(), ok)
app.post('/flats/:flatId/bills/pay', requireAuth, requirePermission('BILL_PAY'), requireFlatAccess({ write: true }), ok)
app.post('/flats/:flatId/invoices', requireAuth, requirePermission('INVOICE_GENERATE'), requireFlatAccess({ write: true, scopePermission: 'INVOICE_GENERATE' }), ok)
// An operation REPORT_VIEW does not authorize per flat: only the flat's Residents may pass
app.get('/flats/:flatId/visits', requireAuth, requirePermission('REPORT_VIEW'), requireFlatAccess(), ok)
app.use(errorHandler)

/** The token's role and society are deliberately wrong to prove both are read from the database. */
async function as(user: { id: string }) {
  const token = await signAccessToken({ userId: user.id, sessionId: 's1', role: 'GUARD', societyId: OTHER_SOCIETY_ID })
  return `Bearer ${token}`
}

/** Verified by default: access follows a verified assignment, which the verify tests override. */
function link(userId: string, flatId: string, extra: Partial<PgInsertValue<typeof flatResidents>> = {}) {
  return db
    .insert(flatResidents)
    .values({ userId, flatId, residentType: 'OWNER', verificationStatus: 'VERIFIED', verifiedBy: userId, verifiedAt: new Date(), ...extra })
}

async function admin(...permissions: AdminPermission[]) {
  const user = await createUser({ phone: '9000000010', email: null, role: 'ADMIN', resident: 'TENANT' })
  await grantPermissions(user.id, permissions)
  return user
}

// Relative to the database's current_date, which is what the check compares against
const day = (offset: number) => sql<string>`current_date + ${offset}::int`

describe('flat ownership and scope', () => {
  it('lets a Resident read and act on their own active flat', async () => {
    const resident = await createUser()
    const flat = await createFlat()
    await link(resident.id, flat.id)

    expect((await request(app).get(`/flats/${flat.id}/bills`).set('Authorization', await as(resident))).status).toBe(200)
    expect((await request(app).post(`/flats/${flat.id}/bills/pay`).set('Authorization', await as(resident))).status).toBe(200)
  })

  it('returns 403 NOT_YOUR_FLAT for another flat in the same society', async () => {
    const resident = await createUser()
    const own = await createFlat()
    const other = await createFlat(TEST_SOCIETY_ID, '102')
    await link(resident.id, own.id)

    const res = await request(app).get(`/flats/${other.id}/bills`).set('Authorization', await as(resident))

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('NOT_YOUR_FLAT')
  })

  it.each([
    ['ended', { startDate: day(-30), endDate: day(-1) }],
    ['not yet started', { startDate: day(1) }],
  ])('refuses a relationship that has %s', async (_label, period) => {
    const resident = await createUser()
    const flat = await createFlat()
    await link(resident.id, flat.id, period)

    const res = await request(app).get(`/flats/${flat.id}/bills`).set('Authorization', await as(resident))

    expect(res.body.error.code).toBe('NOT_YOUR_FLAT')
  })

  it('counts the last valid day as active', async () => {
    const resident = await createUser()
    const flat = await createFlat()
    await link(resident.id, flat.id, { startDate: day(-30), endDate: day(0) })

    expect((await request(app).get(`/flats/${flat.id}/bills`).set('Authorization', await as(resident))).status).toBe(200)
  })

  it('lets a VIEW_ONLY Resident read but not write', async () => {
    const resident = await createUser()
    const flat = await createFlat()
    await link(resident.id, flat.id, { accessLevel: 'VIEW_ONLY' })

    expect((await request(app).get(`/flats/${flat.id}/bills`).set('Authorization', await as(resident))).status).toBe(200)
    const res = await request(app).post(`/flats/${flat.id}/bills/pay`).set('Authorization', await as(resident))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('PERMISSION_DENIED')
  })

  it('returns 403 CROSS_SOCIETY_ACCESS for a flat in another society, even with a scope permission', async () => {
    const billing = await admin('INVOICE_GENERATE')
    const flat = await createFlat(OTHER_SOCIETY_ID)

    const res = await request(app).post(`/flats/${flat.id}/invoices`).set('Authorization', await as(billing))

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('CROSS_SOCIETY_ACCESS')
  })

  it('refuses a Resident linked to a flat in another society', async () => {
    const resident = await createUser()
    const flat = await createFlat(OTHER_SOCIETY_ID)
    await link(resident.id, flat.id)

    const res = await request(app).get(`/flats/${flat.id}/bills`).set('Authorization', await as(resident))

    expect(res.body.error.code).toBe('CROSS_SOCIETY_ACCESS')
  })

  it('lets an Admin with the scope permission act on any flat in their society', async () => {
    const billing = await admin('INVOICE_GENERATE')
    const flat = await createFlat()

    expect((await request(app).post(`/flats/${flat.id}/invoices`).set('Authorization', await as(billing))).status).toBe(200)
  })

  it('does not let committee membership bypass flat ownership', async () => {
    const committee = await admin('REPORT_VIEW')
    const flat = await createFlat()
    await link(committee.id, flat.id)

    const res = await request(app).get(`/flats/${flat.id}/visits`).set('Authorization', await as(committee))

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('PERMISSION_DENIED')
  })

  it('returns 404 for an unknown or malformed flat id', async () => {
    const resident = await createUser()

    for (const id of ['44444444-4444-4444-8444-444444444444', 'not-a-uuid']) {
      expect((await request(app).get(`/flats/${id}/bills`).set('Authorization', await as(resident))).status).toBe(404)
    }
  })

  it('audits denials with the reason code', async () => {
    const resident = await createUser()
    const flat = await createFlat()

    await request(app).get(`/flats/${flat.id}/bills`).set('Authorization', await as(resident))
    await request(app).post(`/flats/${flat.id}/invoices`).set('Authorization', await as(resident))

    const rows = await db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.eventType, 'AUTHORIZATION_DENIED'), eq(auditLogs.actorUserId, resident.id)))
    expect(rows.map((row) => row.metadata.code).sort()).toEqual(['NOT_YOUR_FLAT', 'PERMISSION_DENIED'])
    expect(rows.find((row) => row.metadata.code === 'PERMISSION_DENIED')!.metadata).toMatchObject({ permission: 'INVOICE_GENERATE' })
  })
})

describe('state validation', () => {
  const ctx = { userId: '22222222-2222-4222-8222-222222222222', sessionId: 's1', role: 'ADMIN' as const, societyId: TEST_SOCIETY_ID, permissions: [] }

  it('returns 404 for a missing record and 403 CROSS_SOCIETY_ACCESS for another society', async () => {
    await expect(requireRecord(ctx, undefined, 'Bill')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Bill not found' })
    await createUser({ id: ctx.userId })
    await expect(requireRecord(ctx, { societyId: OTHER_SOCIETY_ID }, 'Bill')).rejects.toMatchObject({ status: 403, code: 'CROSS_SOCIETY_ACCESS' })
  })

  it('passes a record from the same society through', async () => {
    const record = { societyId: TEST_SOCIETY_ID, status: 'UNPAID' }

    await expect(requireRecord(ctx, record, 'Bill')).resolves.toBe(record)
  })

  it('returns 400 INVALID_STATE when the state does not allow the operation', () => {
    expect(() => assertState(false, 'This bill is already paid')).toThrow(expect.objectContaining({ status: 400, code: 'INVALID_STATE' }))
    expect(() => assertState(true, 'unused')).not.toThrow()
  })
})
