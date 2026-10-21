import express from 'express'
import request from 'supertest'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { flatResidents, permissions, rolePermissions, roles, userPermissions } from '../../db/schema.js'
import { errorHandler } from '../../middleware/errorHandler.js'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { addResident, createFlat, createUser, grantPermissions, PASSWORD, postLogin, TEST_SOCIETY_ID } from '../../test/helpers.js'
import { signAccessToken } from '../auth/tokens.js'
import { and, eq, isNull } from 'drizzle-orm'
import {
  ADMIN_PERMISSIONS,
  assignRole,
  COMMITTEE_PERMISSIONS,
  GUARD_PERMISSIONS,
  loadRole,
  RESIDENT_PERMISSIONS,
  type AdminPermission,
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

function grant(userId: string, ...codes: AdminPermission[]) {
  return grantPermissions(userId, codes)
}

/** Codes of the user's active (unrevoked) user-specific permissions */
async function activeGrants(userId: string) {
  const rows = await db
    .select({ code: permissions.code })
    .from(userPermissions)
    .innerJoin(permissions, eq(permissions.id, userPermissions.permissionId))
    .where(and(eq(userPermissions.userId, userId), isNull(userPermissions.revokedAt)))
  return rows.map((row) => row.code).sort()
}

describe('permission master data', () => {
  it('matches the codes the code refers to', async () => {
    const rows = await db.select({ code: permissions.code, description: permissions.description }).from(permissions)

    expect(rows.map((row) => row.code).sort()).toEqual([...ADMIN_PERMISSIONS, ...GUARD_PERMISSIONS, ...RESIDENT_PERMISSIONS].sort())
    expect(rows.every((row) => row.description.length > 0)).toBe(true)
  })

  it('gives Guards and Residents their permissions through role_permissions, and Admins none', async () => {
    const rows = await db
      .select({ role: roles.name, code: permissions.code })
      .from(rolePermissions)
      .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    const codesOf = (role: string) => rows.filter((row) => row.role === role).map((row) => row.code).sort()

    expect(codesOf('GUARD')).toEqual([...GUARD_PERMISSIONS].sort())
    expect(codesOf('RESIDENT')).toEqual([...RESIDENT_PERMISSIONS].sort())
    expect(codesOf('ADMIN')).toEqual([])
  })
})

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
    ['VISIT_REGISTER', true, false],
    ['VISIT_DECIDE', true, false],
    ['VISIT_ENTRY_RECORD', true, false],
    ['VISIT_EXIT', true, false],
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
    await grant(admin.id, ...ADMIN_PERMISSIONS)

    for (const permission of ADMIN_PERMISSIONS) {
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
    const admin = await createUser({ role: 'ADMIN' })
    await grant(admin.id, 'REPORT_VIEW')
    const token = await signAccessToken({ userId: admin.id, sessionId: 's1', role: 'ADMIN', societyId: null })
    await assignRole(db, admin.id, 'RESIDENT')

    const res = await request(app).get('/op/REPORT_VIEW').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
  })

  it('ignores a revoked permission and honours it again once re-granted', async () => {
    const admin = await createUser({ role: 'ADMIN' })
    await grant(admin.id, 'AUDIT_VIEW')
    await db.update(userPermissions).set({ revokedAt: new Date() }).where(eq(userPermissions.userId, admin.id))

    expect((await call(admin, 'AUDIT_VIEW')).status).toBe(403)

    await db.update(userPermissions).set({ revokedAt: null }).where(eq(userPermissions.userId, admin.id))
    expect((await call(admin, 'AUDIT_VIEW')).status).toBe(200)
  })

  it('denies a user with no role assigned', async () => {
    const user = await createUser()
    await db.execute(`delete from user_roles where user_id = '${user.id}'`)

    expect((await call(user, 'BILL_VIEW_OWN')).status).toBe(403)
  })

  it('rejects an inactive user', async () => {
    const guard = await createUser({ role: 'GUARD', isActive: false })

    expect((await call(guard, 'VISIT_REGISTER')).status).toBe(403)
  })
})

describe('resident type', () => {
  it('gives Owners and Tenants the same Resident permissions', async () => {
    const tenant = await createUser({ resident: 'TENANT' })

    expect((await call(tenant, 'BILL_VIEW_OWN')).status).toBe(200)
    expect((await call(tenant, 'USER_MANAGE')).status).toBe(403)
  })
})

describe('committee membership', () => {
  let actor: string
  beforeEach(async () => {
    actor = (await createUser({ name: 'Anita Rao', phone: '9111111111', email: null, role: 'ADMIN' })).id
  })

  it('adds the chosen committee permissions without taking away the resident ones', async () => {
    const resident = await createUser({ resident: 'TENANT' })

    await setCommitteeMembership(actor, resident.id, ['BILLING_RATE_SET', 'REPORT_VIEW'])

    const res = await postLogin(createApp(), { phone: '9876543210', password: PASSWORD })
    expect(res.body.data.user).toMatchObject({
      role: 'ADMIN',
      permissions: [...RESIDENT_PERMISSIONS, 'BILLING_RATE_SET', 'REPORT_VIEW'].sort(),
    })
  })

  it('gives an Admin with no flat assignment nothing a Resident has', async () => {
    const staff = await createUser({ name: 'Mahesh Patil', phone: '9222222222', email: null, role: 'ADMIN' })
    await grantPermissions(staff.id, ['USER_MANAGE'])

    const res = await postLogin(createApp(), { phone: '9222222222', password: PASSWORD })
    expect(res.body.data.user).toMatchObject({ role: 'ADMIN', permissions: ['USER_MANAGE'] })
  })

  it('removes committee permissions and restores the Resident role, keeping the flat assignment', async () => {
    const resident = await createUser({ resident: 'TENANT' })
    await setCommitteeMembership(actor, resident.id, [...COMMITTEE_PERMISSIONS])

    await removeCommitteeMembership(actor, resident.id)

    const [link] = await db.select().from(flatResidents).where(eq(flatResidents.userId, resident.id))
    expect(link).toMatchObject({ residentType: 'TENANT', verificationStatus: 'VERIFIED' })
    expect(await loadRole(db, resident.id)).toBe('RESIDENT')
    expect(await activeGrants(resident.id)).toEqual([])
    // Revoked grants stay as history, with who granted them
    const history = await db.select().from(userPermissions).where(eq(userPermissions.userId, resident.id))
    expect(history).toHaveLength(COMMITTEE_PERMISSIONS.length)
    expect(history.every((row) => row.revokedAt && row.grantedBy === actor)).toBe(true)
  })

  it('keeps separately assigned General Admin permissions when committee membership ends', async () => {
    const resident = await createUser({ resident: 'OWNER' })
    await setCommitteeMembership(actor, resident.id, ['REPORT_VIEW'])
    await grant(resident.id, 'USER_MANAGE')

    await removeCommitteeMembership(actor, resident.id)

    expect(await activeGrants(resident.id)).toEqual(['USER_MANAGE'])
    expect(await loadRole(db, resident.id)).toBe('ADMIN')
  })

  it('replaces the committee permissions when set again, and can restore a revoked one', async () => {
    const resident = await createUser({ resident: 'OWNER' })
    await setCommitteeMembership(actor, resident.id, ['REPORT_VIEW', 'BILLING_RATE_SET'])

    await setCommitteeMembership(actor, resident.id, ['INVOICE_GENERATE'])
    expect(await activeGrants(resident.id)).toEqual(['INVOICE_GENERATE'])

    await setCommitteeMembership(actor, resident.id, ['REPORT_VIEW'])
    expect(await activeGrants(resident.id)).toEqual(['REPORT_VIEW'])
  })

  it.each([
    ['a Guard', { role: 'GUARD' as const }, ['REPORT_VIEW']],
    ['a General Admin permission', { resident: 'OWNER' as const }, ['USER_MANAGE']],
    ['no permissions', { resident: 'OWNER' as const }, []],
  ])('refuses %s', async (_case, overrides, permissions) => {
    const user = await createUser(overrides)

    await expect(setCommitteeMembership(actor, user.id, permissions as never)).rejects.toMatchObject({ code: 'COMMITTEE_NOT_ALLOWED' })
  })

  // Resident identity is a verified assignment, so a registration awaiting approval is not enough
  it('refuses a user whose flat assignment is still pending', async () => {
    const user = await createUser()
    const flat = await createFlat(TEST_SOCIETY_ID, '777')
    await addResident(flat.id, user.id, { verificationStatus: 'PENDING' })

    await expect(setCommitteeMembership(actor, user.id, ['REPORT_VIEW'])).rejects.toMatchObject({
      code: 'COMMITTEE_NOT_ALLOWED',
    })
  })
})
