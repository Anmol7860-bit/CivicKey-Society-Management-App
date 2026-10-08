import express from 'express'
import { SignJWT } from 'jose'
import request from 'supertest'
import { createApp } from '../app.js'
import { signAccessToken } from '../modules/auth/tokens.js'
import { errorHandler } from './errorHandler.js'
import { requireAuth } from './requireAuth.js'

const secret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET)
const userId = '22222222-2222-4222-8222-222222222222'
const societyId = '11111111-1111-4111-8111-111111111111'

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
    .setSubject(userId)
    .setIssuer('civickey-api')
    .setAudience('civickey-app')
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? '15m')
    .sign(options.key ?? secret)
}

describe('requireAuth', () => {
  it('attaches userId, role and societyId for a valid token', async () => {
    const token = await signAccessToken({ userId, sessionId: 's1', role: 'ADMIN', societyId })

    const res = await getProtected(`Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ userId, sessionId: 's1', role: 'ADMIN', societyId })
  })

  it('allows a null society', async () => {
    const token = await signAccessToken({ userId, sessionId: 's1', role: 'RESIDENT', societyId: null })

    const res = await getProtected(`Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.societyId).toBeNull()
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
    ['a non-Bearer scheme', async () => `Basic ${await signAccessToken({ userId, sessionId: 's1', role: 'RESIDENT', societyId })}`],
    ['an empty Bearer token', async () => 'Bearer '],
    ['a malformed token', async () => 'Bearer not.a.jwt'],
    ['a wrong signature', async () => `Bearer ${await signWith({ role: 'RESIDENT', society_id: null }, { key: new TextEncoder().encode('x'.repeat(32)) })}`],
    ['an unknown role', async () => `Bearer ${await signWith({ role: 'SUPERUSER', society_id: null, sid: 's1' })}`],
    ['a missing session claim', async () => `Bearer ${await signWith({ role: 'RESIDENT', society_id: null })}`],
    ['a missing society claim', async () => `Bearer ${await signWith({ role: 'RESIDENT', sid: 's1' })}`],
    ['a payload tampered after signing', async () => {
      const [header, payload, signature] = (await signAccessToken({ userId, sessionId: 's1', role: 'RESIDENT', societyId })).split('.')
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString())
      const forged = Buffer.from(JSON.stringify({ ...claims, role: 'ADMIN' })).toString('base64url')
      return `Bearer ${header}.${forged}.${signature}`
    }],
    ['alg none', async () => {
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
      const payload = { sub: userId, role: 'ADMIN', society_id: null, iss: 'civickey-api', aud: 'civickey-app', exp: 9999999999 }
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
