import request from 'supertest'
import type { createApp } from '../app.js'
import { db } from '../db/client.js'
import { inArray } from 'drizzle-orm'
import type { PgInsertValue } from 'drizzle-orm/pg-core'
import {
  blocks,
  flatResidents,
  flats,
  floors,
  permissions,
  societies,
  storedFiles,
  userPermissions,
  users,
  type NewUser,
  type ResidentType,
  type Role,
} from '../db/schema.js'
import { assignRole, type AdminPermission } from '../modules/access/permissions.js'
import { hashPassword } from '../modules/auth/password.js'

export type App = ReturnType<typeof createApp>

export const PASSWORD = 'Resident@123'

export const TEST_SOCIETY_ID = '11111111-1111-4111-8111-111111111111'

let flatNumber = 900

/**
 * Creates a user with a role in user_roles (default RESIDENT). `resident` also gives them a
 * verified assignment on a flat of their own, which is what now makes someone a Resident.
 */
export async function createUser({
  role = 'RESIDENT',
  resident,
  ...overrides
}: Partial<NewUser> & { role?: Role; resident?: ResidentType } = {}) {
  await db.insert(societies).values({ id: TEST_SOCIETY_ID, name: 'Test Society' }).onConflictDoNothing()
  const [user] = await db
    .insert(users)
    .values({
      name: 'Riya Sharma',
      phone: '9876543210',
      email: 'riya@example.com',
      societyId: TEST_SOCIETY_ID,
      passwordHash: await hashPassword(PASSWORD),
      ...overrides,
    })
    .returning()
  await assignRole(db, user!.id, role)
  if (resident) {
    const flat = await createFlat(TEST_SOCIETY_ID, String((flatNumber += 1)))
    await addResident(flat.id, user!.id, { residentType: resident })
  }
  return { ...user!, role }
}

/** A flat assignment, verified by default; a tenancy gets a far-off end date unless given one. */
export async function addResident(flatId: string, userId: string, overrides: Partial<PgInsertValue<typeof flatResidents>> = {}) {
  const decided = overrides.verificationStatus === 'PENDING' || overrides.verificationStatus === 'REJECTED'
  const [row] = await db
    .insert(flatResidents)
    .values({
      flatId,
      userId,
      residentType: 'OWNER',
      ...(overrides.residentType === 'TENANT' ? { endDate: '2099-12-31' } : {}),
      ...(decided ? {} : { verificationStatus: 'VERIFIED', verifiedBy: userId, verifiedAt: new Date() }),
      ...overrides,
    })
    .returning()
  return row!
}

/** Grants user-specific permissions; the grantee is recorded as granter unless one is given. */
export async function grantPermissions(userId: string, codes: AdminPermission[], grantedBy = userId) {
  const rows = await db.select({ id: permissions.id }).from(permissions).where(inArray(permissions.code, codes))
  await db.insert(userPermissions).values(rows.map((row) => ({ userId, permissionId: row.id, grantedBy })))
}

/** A flat in block A on floor "1st Floor", creating the society, block and floor as needed. */
export async function createFlat(societyId = TEST_SOCIETY_ID, number = '101') {
  await db.insert(societies).values({ id: societyId, name: 'Society' }).onConflictDoNothing()
  const [block] = await db.insert(blocks).values({ societyId, name: `A-${number}` }).returning()
  const [floor] = await db.insert(floors).values({ blockId: block!.id, floorLabel: '1st Floor' }).returning()
  const [flat] = await db.insert(flats).values({ blockId: block!.id, floorId: floor!.id, number }).returning()
  return flat!
}

/**
 * A stored photo, as POST /files would have left one, for the records that require a reference.
 * Only the row matters to validation; tests that care about the bytes upload them properly.
 */
export async function createPhoto(societyId = TEST_SOCIETY_ID) {
  await db.insert(societies).values({ id: societyId, name: 'Society' }).onConflictDoNothing()
  const [file] = await db
    .insert(storedFiles)
    .values({ societyId, contentType: 'image/jpeg', byteSize: 1024 })
    .returning()
  return file!.id
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
