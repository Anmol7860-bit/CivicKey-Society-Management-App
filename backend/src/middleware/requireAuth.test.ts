import { eq } from 'drizzle-orm'
import express from 'express'
import { SignJWT } from 'jose'
import request from 'supertest'
import { createApp } from '../app.js'
import { db } from '../db/client.js'
import { authSessions } from '../db/schema.js'
import { signAccessToken } from '../modules/auth/tokens.js'
import { createUser, signTestToken, TEST_SOCIETY_ID } from '../test/helpers.js'
import { errorHandler } from './errorHandler.js'
import { requireAuth } from './requireAuth.js'

const secret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET)
const societyId = TEST_SOCIETY_ID
// A token's own claims are checked before the session is looked up, so the cases that must fail
// on the claims alone need no account behind them
const strangerId = '22222222-2222-4222-8222-222222222222'
let userId: string

// Stand-in for a protected endpoint until real ones exist
const app = express()
app.get('/protected', requireAuth, (req, res) => {
  res.json({ data: req.ctx })
})
app.use(errorHandler)

function getProtected(authorization?: string) {
  const req = request(app).get('/protected')
  return authorization === undefined ? req : req.set('Authorization', authorization)
}

function signWith(claims: Record<string, unknown>, options: { expiresAt?: number; key?: Uint8Array } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(strangerId)
    .setIssuer('civickey-api')
    .setAudience('civickey-app')
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? '15m')
    .sign(options.key ?? secret)
}

describe('requireAuth', () => {
  beforeEach(async () => {
    userId = (await createUser()).id
  })

  it('attaches userId, role and societyId for a valid token', async () => {
    const token = await signTestToken({ userId, role: 'ADMIN', societyId })

    const res = await getProtected(`Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ userId, role: 'ADMIN', societyId })
    expect(res.body.data.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('allows a null society', async () => {
    const token = await signTestToken({ userId, role: 'RESIDENT', societyId: null })

    const res = await getProtected(`Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.societyId).toBeNull()
  })

  // The token stays verifiable until it expires, so these are what stop a signed-out token working
  it('returns 401 for a token whose session was revoked, e.g. by logging out', async () => {
    const token = await signTestToken({ userId, role: 'ADMIN', societyId })
    await db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.userId, userId))

    const res = await getProtected(`Bearer ${token}`)

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('TOKEN_INVALID')
  })

  it('returns 401 for a token whose session has expired', async () => {
    const token = await signTestToken({ userId, role: 'ADMIN', societyId })
    await db.update(authSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authSessions.userId, userId))

    const res = await getProtected(`Bearer ${token}`)

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('TOKEN_INVALID')
  })

  it('returns 401 for a token naming a session that does not exist', async () => {
    const token = await signAccessToken({ userId, sessionId: '33333333-3333-4333-8333-333333333333', role: 'ADMIN', societyId })

    const res = await getProtected(`Bearer ${token}`)

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('TOKEN_INVALID')
  })

  it('returns 401 TOKEN_MISSING without an Authorization header', async () => {
    const res = await getProtected()

    expect(res.status).toBe(401)
    expect(res.body.error).toEqual({ code: 'TOKEN_MISSING', message: 'Authentication required' })
  })

  it('returns 401 TOKEN_EXPIRED for an expired token', async () => {
    const token = await signWith({ role: 'RESIDENT', society_id: null }, { expiresAt: Math.floor(Date.now() / 1000) - 60 })

    const res = await getProtected(`Bearer ${token}`)

    expect(res.status).toBe(401)
    expect(res.body.error).toEqual({ code: 'TOKEN_EXPIRED', message: 'Authentication failed' })
  })

  it.each([
    ['a non-Bearer scheme', async () => `Basic ${await signAccessToken({ userId: strangerId, sessionId: 's1', role: 'RESIDENT', societyId })}`],
    ['an empty Bearer token', async () => 'Bearer '],
    ['a malformed token', async () => 'Bearer not.a.jwt'],
    ['a wrong signature', async () => `Bearer ${await signWith({ role: 'RESIDENT', society_id: null }, { key: new TextEncoder().encode('x'.repeat(32)) })}`],
    ['an unknown role', async () => `Bearer ${await signWith({ role: 'SUPERUSER', society_id: null, sid: 's1' })}`],
    ['a missing session claim', async () => `Bearer ${await signWith({ role: 'RESIDENT', society_id: null })}`],
    ['a missing society claim', async () => `Bearer ${await signWith({ role: 'RESIDENT', sid: 's1' })}`],
    ['a payload tampered after signing', async () => {
      const [header, payload, signature] = (await signAccessToken({ userId: strangerId, sessionId: 's1', role: 'RESIDENT', societyId })).split('.')
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString())
      const forged = Buffer.from(JSON.stringify({ ...claims, role: 'ADMIN' })).toString('base64url')
      return `Bearer ${header}.${forged}.${signature}`
    }],
    ['alg none', async () => {
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
      const payload = { sub: strangerId, role: 'ADMIN', society_id: null, iss: 'civickey-api', aud: 'civickey-app', exp: 9999999999 }
      return `Bearer ${encode({ alg: 'none' })}.${encode(payload)}.`
    }],
  ])('returns 401 TOKEN_INVALID for %s', async (_case, authorization) => {
    const res = await getProtected(await authorization())

    expect(res.status).toBe(401)
    expect(res.body.error).toEqual({ code: 'TOKEN_INVALID', message: 'Authentication failed' })
  })
})

describe('request IDs', () => {
  it('generates an X-Request-Id when the client sends none', async () => {
    const res = await request(createApp()).get('/api/v1/health')

    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('echoes a well-formed incoming X-Request-Id', async () => {
    const res = await request(createApp()).get('/api/v1/health').set('X-Request-Id', 'abc-123')

    expect(res.headers['x-request-id']).toBe('abc-123')
  })

  it('replaces a malformed incoming X-Request-Id', async () => {
    const res = await request(createApp()).get('/api/v1/health').set('X-Request-Id', 'bad id\twith spaces')

    expect(res.headers['x-request-id']).not.toBe('bad id\twith spaces')
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })
})
