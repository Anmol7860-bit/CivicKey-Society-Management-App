import express from 'express'
import request from 'supertest'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { adminPermission, userPermissions, users, type AdminPermission } from '../../db/schema.js'
import { errorHandler } from '../../middleware/errorHandler.js'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { createUser, PASSWORD, postLogin } from '../../test/helpers.js'
import { signAccessToken } from '../auth/tokens.js'
import { eq } from 'drizzle-orm'
import {
  COMMITTEE_PERMISSIONS,
  removeCommitteeMembership,
  setCommitteeMembership,
  type Permission,
} from './permissions.js'

// Stand-in for protected operations until the real endpoints exist
const app = express()
app.get('/op/:permission', requireAuth, (req, res, next) => requirePermission(req.params.permission as Permission)(req, res, next), (req, res) => {
  res.json({ data: { permissions: req.ctx!.permissions } })
})
app.use(errorHandler)

async function call(user: { id: string; role: 'ADMIN' | 'GUARD' | 'RESIDENT' }, permission: string) {
  const token = await signAccessToken({ userId: user.id, sessionId: 's1', role: user.role, societyId: null })
  return request(app).get(`/op/${permission}`).set('Authorization', `Bearer ${token}`)
}

async function grant(userId: string, ...permissions: AdminPermission[]) {
  await db.insert(userPermissions).values(permissions.map((permission) => ({ userId, permission })))
}

describe('permission matrix', () => {
  // [permission, guard allowed, resident allowed]; Admin rows are covered by the assignment tests below
  const matrix: Array<[Permission, boolean, boolean]> = [
    ['SOCIETY_MANAGE', false, false],
    ['USER_MANAGE', false, false],
    ['GUARD_MANAGE', false, false],
    ['STAFF_MANAGE', false, false],
    ['BILLING_RATE_SET', false, false],
    ['INVOICE_GENERATE', false, false],
    ['PAYMENT_CASH_MARK', false, false],
    ['REPORT_VIEW', false, false],
    ['AUDIT_VIEW', false, false],
    ['VISITOR_REGISTER', true, false],
    ['VISIT_DECIDE', true, false],
    ['VISIT_ENTRY_RECORD', true, false],
    ['VISIT_EXIT_RECORD', true, false],
    ['PASS_VALIDATE', true, false],
    ['VISITOR_APPROVE', false, true],
    ['VISITOR_PASS_CREATE', false, true],
    ['VISIT_VIEW_OWN', false, true],
    ['BILL_VIEW_OWN', false, true],
    ['BILL_PAY', false, true],
    ['RECEIPT_VIEW_OWN', false, true],
  ]

  it.each(matrix)('%s: guard=%s resident=%s', async (permission, guardAllowed, residentAllowed) => {
    const guard = await createUser({ phone: '9000000001', email: null, role: 'GUARD' })
    const resident = await createUser({ phone: '9000000002', email: null, role: 'RESIDENT' })

    expect((await call(guard, permission)).status).toBe(guardAllowed ? 200 : 403)
    expect((await call(resident, permission)).status).toBe(residentAllowed ? 200 : 403)
  })

  it('gives an Admin only the Admin permissions assigned to them', async () => {
    const admin = await createUser({ phone: '9000000003', email: null, role: 'ADMIN' })
    await grant(admin.id, 'USER_MANAGE')

    expect((await call(admin, 'USER_MANAGE')).status).toBe(200)
    for (const permission of ['SOCIETY_MANAGE', 'BILLING_RATE_SET', 'AUDIT_VIEW', 'VISIT_DECIDE', 'VISITOR_APPROVE']) {
      expect((await call(admin, permission)).status).toBe(403)
    }
  })

  it('lets an Admin use every Admin permission assigned to them', async () => {
    const admin = await createUser({ phone: '9000000005', email: null, role: 'ADMIN' })
    await grant(admin.id, ...adminPermission.enumValues)

    for (const permission of adminPermission.enumValues) {
      expect((await call(admin, permission)).status).toBe(200)
    }
  })

  it('ignores Admin permissions stored for a non-Admin', async () => {
    const guard = await createUser({ phone: '9000000004', email: null, role: 'GUARD' })
    await grant(guard.id, 'USER_MANAGE')

    expect((await call(guard, 'USER_MANAGE')).status).toBe(403)
  })

  it('returns 403 PERMISSION_DENIED without saying which permission was missing', async () => {
    const resident = await createUser()

    const res = await call(resident, 'AUDIT_VIEW')

    expect(res.body.error).toEqual({ code: 'PERMISSION_DENIED', message: 'You are not authorized to perform this action.' })
  })

  it('uses the role in the database, not the one in a still-valid token', async () => {
    const admin = await createUser({ role: 'ADMIN', residentType: 'OWNER' })
    await grant(admin.id, 'REPORT_VIEW')
    const token = await signAccessToken({ userId: admin.id, sessionId: 's1', role: 'ADMIN', societyId: null })
    await db.update(users).set({ role: 'RESIDENT' }).where(eq(users.id, admin.id))

    const res = await request(app).get('/op/REPORT_VIEW').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
  })

  it('rejects an inactive user', async () => {
    const guard = await createUser({ role: 'GUARD', isActive: false })

    expect((await call(guard, 'VISITOR_REGISTER')).status).toBe(403)
  })
})

describe('resident type', () => {
  it('requires a type for Residents and forbids one for Guards', async () => {
    await expect(createUser({ role: 'RESIDENT', residentType: null })).rejects.toThrow()
    await expect(createUser({ role: 'GUARD', residentType: 'TENANT' })).rejects.toThrow()
  })

  it('gives Owners and Tenants the same Resident permissions', async () => {
    const tenant = await createUser({ residentType: 'TENANT' })

    expect((await call(tenant, 'BILL_VIEW_OWN')).status).toBe(200)
    expect((await call(tenant, 'USER_MANAGE')).status).toBe(403)
  })
})

describe('committee membership', () => {
  let actor: string
  beforeEach(async () => {
    actor = (await createUser({ name: 'Anita Rao', phone: '9111111111', email: null, role: 'ADMIN' })).id
  })

  it('makes a Resident an Admin with only the chosen committee permissions', async () => {
    const resident = await createUser({ residentType: 'TENANT' })

    await setCommitteeMembership(actor, resident.id, ['BILLING_RATE_SET', 'REPORT_VIEW'])

    const res = await postLogin(createApp(), { phone: '9876543210', password: PASSWORD })
    expect(res.body.data.user).toMatchObject({
      role: 'ADMIN',
      residentType: 'TENANT',
      permissions: ['BILLING_RATE_SET', 'REPORT_VIEW'],
    })
  })

  it('removes committee permissions and restores the Resident role and type', async () => {
    const resident = await createUser({ residentType: 'TENANT' })
    await setCommitteeMembership(actor, resident.id, [...COMMITTEE_PERMISSIONS])

    await removeCommitteeMembership(actor, resident.id)

    const [user] = await db.select().from(users).where(eq(users.id, resident.id))
    expect(user).toMatchObject({ role: 'RESIDENT', residentType: 'TENANT' })
    expect(await db.select().from(userPermissions)).toEqual([])
  })

  it('keeps separately assigned General Admin permissions when committee membership ends', async () => {
    const resident = await createUser()
    await setCommitteeMembership(actor, resident.id, ['REPORT_VIEW'])
    await grant(resident.id, 'USER_MANAGE')

    await removeCommitteeMembership(actor, resident.id)

    const rows = await db.select().from(userPermissions)
    expect(rows.map((row) => row.permission)).toEqual(['USER_MANAGE'])
    const [user] = await db.select().from(users).where(eq(users.id, resident.id))
    expect(user!.role).toBe('ADMIN')
  })

  it.each([
    ['a Guard', { role: 'GUARD' as const }, ['REPORT_VIEW']],
    ['a General Admin permission', {}, ['USER_MANAGE']],
    ['no permissions', {}, []],
  ])('refuses %s', async (_case, overrides, permissions) => {
    const user = await createUser(overrides)

    await expect(setCommitteeMembership(actor, user.id, permissions as never)).rejects.toMatchObject({ code: 'COMMITTEE_NOT_ALLOWED' })
  })
})
