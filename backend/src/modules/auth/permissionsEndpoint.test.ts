import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { users, type User } from '../../db/schema.js'
import { createUser, grantPermissions } from '../../test/helpers.js'
import { signAccessToken } from './tokens.js'

const app = createApp()

/** The token's role is wrong on purpose: the response must come from the database. */
async function getPermissions(user: Pick<User, 'id'>) {
  const token = await signAccessToken({ userId: user.id, sessionId: 's1', role: 'GUARD', societyId: null })
  return request(app).get('/api/v1/auth/permissions').set('Authorization', `Bearer ${token}`)
}

describe('GET /api/v1/auth/permissions', () => {
  it("returns a Resident's role and permissions", async () => {
    const resident = await createUser({ resident: 'TENANT' })

    const res = await getPermissions(resident)

    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body.data).toEqual({
      userId: resident.id,
      role: 'RESIDENT',
      permissions: ['BILL_PAY', 'BILL_VIEW_OWN', 'RECEIPT_VIEW_OWN', 'VISITOR_APPROVE', 'VISITOR_PASS_CREATE', 'VISIT_VIEW_OWN'],
    })
  })

  it('returns only the permissions assigned to a committee member', async () => {
    const committee = await createUser({ role: 'ADMIN', resident: 'OWNER' })
    await grantPermissions(committee.id, ['REPORT_VIEW', 'BILLING_RATE_SET'])

    const res = await getPermissions(committee)

    expect(res.body.data).toMatchObject({ role: 'ADMIN', permissions: ['BILLING_RATE_SET', 'REPORT_VIEW'] })
  })

  it('says nothing about a resident type, which now lives on the assignment', async () => {
    const guard = await createUser({ role: 'GUARD' })

    const res = await getPermissions(guard)

    expect(res.body.data).toMatchObject({ role: 'GUARD' })
    expect(res.body.data).not.toHaveProperty('residentType')
  })

  it('returns 403 ROLE_NOT_ASSIGNED for a deactivated or deleted user', async () => {
    const user = await createUser({ isActive: false })
    expect((await getPermissions(user)).body.error.code).toBe('ROLE_NOT_ASSIGNED')

    await db.delete(users).where(eq(users.id, user.id))
    const res = await getPermissions(user)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('ROLE_NOT_ASSIGNED')
  })

  it('returns 403 ROLE_NOT_ASSIGNED when the user has no role', async () => {
    const user = await createUser()
    await db.execute(`delete from user_roles where user_id = '${user.id}'`)

    expect((await getPermissions(user)).body.error.code).toBe('ROLE_NOT_ASSIGNED')
  })

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/v1/auth/permissions')

    expect(res.status).toBe(401)
  })
})
