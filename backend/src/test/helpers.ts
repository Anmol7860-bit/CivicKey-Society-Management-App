import request from 'supertest'
import type { createApp } from '../app.js'
import { db } from '../db/client.js'
import { inArray } from 'drizzle-orm'
import { permissions, societies, userPermissions, users, type NewUser, type Role } from '../db/schema.js'
import { assignRole, type AdminPermission } from '../modules/access/permissions.js'
import { hashPassword } from '../modules/auth/password.js'

export type App = ReturnType<typeof createApp>

export const PASSWORD = 'Resident@123'

export const TEST_SOCIETY_ID = '11111111-1111-4111-8111-111111111111'

/** Creates a user with a role in user_roles (default RESIDENT). */
export async function createUser({ role = 'RESIDENT', ...overrides }: Partial<NewUser> & { role?: Role } = {}) {
  await db.insert(societies).values({ id: TEST_SOCIETY_ID, name: 'Test Society' }).onConflictDoNothing()
  const [user] = await db
    .insert(users)
    .values({
      name: 'Riya Sharma',
      phone: '9876543210',
      email: 'riya@example.com',
      residentType: role === 'RESIDENT' ? 'OWNER' : null,
      societyId: TEST_SOCIETY_ID,
      passwordHash: await hashPassword(PASSWORD),
      ...overrides,
    })
    .returning()
  await assignRole(db, user!.id, role)
  return { ...user!, role }
}

/** Grants user-specific permissions; the grantee is recorded as granter unless one is given. */
export async function grantPermissions(userId: string, codes: AdminPermission[], grantedBy = userId) {
  const rows = await db.select({ id: permissions.id }).from(permissions).where(inArray(permissions.code, codes))
  await db.insert(userPermissions).values(rows.map((row) => ({ userId, permissionId: row.id, grantedBy })))
}

export function postLogin(app: App, body: unknown) {
  return request(app).post('/api/v1/auth/login').set('User-Agent', 'vitest').send(body as object)
}

/** POST /auth/refresh, optionally sending a refresh token as the ck_refresh cookie. */
export function postRefresh(app: App, refreshToken?: string) {
  const req = request(app).post('/api/v1/auth/refresh').set('User-Agent', 'vitest')
  return refreshToken === undefined ? req : req.set('Cookie', `ck_refresh=${refreshToken}`)
}

export function refreshCookie(res: request.Response) {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  return cookies.find((cookie) => cookie.startsWith('ck_refresh='))
}

/** The raw refresh token from a response's Set-Cookie header. */
export function refreshTokenFrom(res: request.Response) {
  const cookie = refreshCookie(res)
  if (!cookie) throw new Error('Response did not set ck_refresh')
  return decodeURIComponent(cookie.split(';')[0]!.slice('ck_refresh='.length))
}
