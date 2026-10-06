import request from 'supertest'
import type { createApp } from '../app.js'
import { db } from '../db/client.js'
import { users, type NewUser } from '../db/schema.js'
import { hashPassword } from '../modules/auth/password.js'

export type App = ReturnType<typeof createApp>

export const PASSWORD = 'Resident@123'

export async function createUser(overrides: Partial<NewUser> = {}) {
  const [user] = await db
    .insert(users)
    .values({
      name: 'Riya Sharma',
      phone: '9876543210',
      email: 'riya@example.com',
      role: 'RESIDENT',
      societyId: '11111111-1111-4111-8111-111111111111',
      passwordHash: await hashPassword(PASSWORD),
      ...overrides,
    })
    .returning()
  return user!
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
