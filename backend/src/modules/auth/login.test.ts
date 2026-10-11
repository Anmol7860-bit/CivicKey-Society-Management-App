import { Writable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { decodeJwt, jwtVerify } from 'jose'
import request from 'supertest'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { auditLogs, authSessions, refreshTokens, users } from '../../db/schema.js'
import { createLogger } from '../../lib/logger.js'
import { PASSWORD, createUser, postLogin, refreshCookie, refreshTokenFrom, type App } from '../../test/helpers.js'
import { hashRefreshToken } from './tokens.js'

describe('POST /api/v1/auth/login', () => {
  let app: App

  beforeEach(() => {
    app = createApp()
  })

  describe('success', () => {
    it('returns 200 with an access token, the user role and a safe profile', async () => {
      const user = await createUser()

      const res = await postLogin(app, { phone: '9876543210', password: PASSWORD })

      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.body.data).toMatchObject({
        tokenType: 'Bearer',
        expiresIn: 900,
        user: {
          id: user.id,
          name: 'Riya Sharma',
          phone: '9876543210',
          email: 'riya@example.com',
          role: 'RESIDENT',
          residentType: 'OWNER',
          societyId: user.societyId,
          permissions: ['BILL_PAY', 'BILL_VIEW_OWN', 'RECEIPT_VIEW_OWN', 'VISITOR_APPROVE', 'VISITOR_PASS_CREATE', 'VISIT_VIEW_OWN'],
        },
      })
      expect(Object.keys(res.body.data.user).sort()).toEqual(['email', 'id', 'name', 'permissions', 'phone', 'residentType', 'role', 'societyId'])
    })

    it('issues an access token carrying user, role, society and session', async () => {
      const user = await createUser()

      const res = await postLogin(app, { phone: '9876543210', password: PASSWORD })
      const { payload, protectedHeader } = await jwtVerify(
        res.body.data.accessToken,
        new TextEncoder().encode(process.env.JWT_ACCESS_SECRET),
        { issuer: 'civickey-api', audience: 'civickey-app' },
      )

      const [session] = await db.select().from(authSessions)
      expect(protectedHeader.alg).toBe('HS256')
      expect(payload).toMatchObject({ sub: user.id, role: 'RESIDENT', society_id: user.societyId, sid: session!.id })
      expect(payload.exp! - payload.iat!).toBe(900)
    })

    it('creates a session storing only the refresh-token hash', async () => {
      const user = await createUser()

      const res = await postLogin(app, { phone: '9876543210', password: PASSWORD })
      const cookie = refreshCookie(res)
      const rawToken = refreshTokenFrom(res)

      expect(cookie).toMatch(/HttpOnly/)
      expect(cookie).toMatch(/SameSite=Strict/)
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/)

      const sessions = await db.select().from(authSessions)
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({ userId: user.id, userAgent: 'vitest', revokedAt: null })
      expect(sessions[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000)

      const tokens = await db.select().from(refreshTokens)
      expect(tokens).toHaveLength(1)
      expect(tokens[0]).toMatchObject({ sessionId: sessions[0]!.id, rotatedAt: null, revokedAt: null })
      expect(tokens[0]!.tokenHash).toBe(hashRefreshToken(rawToken))
      expect(tokens[0]!.tokenHash).not.toBe(rawToken)
    })

    it('records a successful login audit event and updates last login time', async () => {
      const user = await createUser()

      await postLogin(app, { phone: '9876543210', password: PASSWORD })

      const [event] = await db.select().from(auditLogs)
      expect(event).toMatchObject({
        eventType: 'AUTH_LOGIN_SUCCESS',
        actorUserId: user.id,
        userAgent: 'vitest',
        metadata: { identifierType: 'phone', identifier: '******3210', role: 'RESIDENT' },
      })
      const [updated] = await db.select().from(users).where(eq(users.id, user.id))
      expect(updated!.lastLoginAt).toBeInstanceOf(Date)
    })

    it('accepts email as the login identifier, case-insensitively', async () => {
      await createUser()

      const res = await postLogin(app, { email: 'Riya@Example.com', password: PASSWORD })

      expect(res.status).toBe(200)
      expect(res.body.data.user.role).toBe('RESIDENT')
    })

    it.each(['RESIDENT', 'GUARD', 'ADMIN'] as const)('signs in a %s without the client sending a role', async (role) => {
      await createUser({ role })

      const res = await postLogin(app, { phone: '9876543210', password: PASSWORD })

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.body.data.user.role).toBe(role)
      expect(decodeJwt(res.body.data.accessToken).role).toBe(role)
    })
  })

  describe('invalid credentials', () => {
    it('returns 401 for a wrong password', async () => {
      await createUser()

      const res = await postLogin(app, { phone: '9876543210', password: 'wrong-password' })

      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid login credentials' } })
      expect(refreshCookie(res)).toBeUndefined()
      expect(await db.select().from(authSessions)).toHaveLength(0)
    })

    it('returns the same generic 401 for an unknown phone', async () => {
      const res = await postLogin(app, { phone: '9000000000', password: PASSWORD })

      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid login credentials' } })
    })

    it('audits failed attempts without the password', async () => {
      const user = await createUser()

      await postLogin(app, { phone: '9876543210', password: 'wrong-password' })
      await postLogin(app, { phone: '9000000000', password: 'other-wrong' })

      const events = await db.select().from(auditLogs).orderBy(auditLogs.createdAt)
      expect(events.map((event) => [event.eventType, event.actorUserId, event.metadata.reason])).toEqual([
        ['AUTH_LOGIN_FAILED', user.id, 'INVALID_CREDENTIALS'],
        ['AUTH_LOGIN_FAILED', null, 'INVALID_CREDENTIALS'],
      ])
      expect(JSON.stringify(events)).not.toMatch(/wrong-password|other-wrong/)
    })
  })

  describe('inactive user', () => {
    it('returns 403 USER_INACTIVE when the password is correct', async () => {
      await createUser({ isActive: false })

      const res = await postLogin(app, { phone: '9876543210', password: PASSWORD })

      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('USER_INACTIVE')
      expect(await db.select().from(authSessions)).toHaveLength(0)
      const [event] = await db.select().from(auditLogs)
      expect(event!.metadata.reason).toBe('USER_INACTIVE')
    })

    it('does not reveal inactive status for a wrong password', async () => {
      await createUser({ isActive: false })

      const res = await postLogin(app, { phone: '9876543210', password: 'wrong-password' })

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS')
    })
  })

  describe('selected role', () => {
    it('signs in when the selected role matches the account', async () => {
      await createUser({ role: 'GUARD' })

      const res = await postLogin(app, { phone: '9876543210', password: PASSWORD, role: 'GUARD' })

      expect(res.status).toBe(200)
      expect(res.body.data.user.role).toBe('GUARD')
    })

    it('returns 403 ROLE_MISMATCH without creating a session when the role is wrong', async () => {
      const user = await createUser({ role: 'RESIDENT' })

      const res = await postLogin(app, { phone: '9876543210', password: PASSWORD, role: 'ADMIN' })

      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('ROLE_MISMATCH')
      expect(refreshCookie(res)).toBeUndefined()
      expect(await db.select().from(authSessions).where(eq(authSessions.userId, user.id))).toHaveLength(0)
      const [event] = await db.select().from(auditLogs).where(eq(auditLogs.actorUserId, user.id))
      expect(event!.metadata).toMatchObject({ reason: 'ROLE_MISMATCH', selectedRole: 'ADMIN' })
    })

    it('does not reveal the role for a wrong password', async () => {
      await createUser({ role: 'RESIDENT' })

      const res = await postLogin(app, { phone: '9876543210', password: 'wrong-password', role: 'ADMIN' })

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS')
    })
  })

  describe('validation', () => {
    it.each([
      ['empty body', {}],
      ['missing password', { phone: '9876543210' }],
      ['missing identifier', { password: PASSWORD }],
      ['empty password', { phone: '9876543210', password: '' }],
      ['short phone', { phone: '98765', password: PASSWORD }],
      ['phone with letters', { phone: '98765abcde', password: PASSWORD }],
      ['non-Indian mobile number', { phone: '5876543210', password: PASSWORD }],
      ['phone with +91 prefix', { phone: '+919876543210', password: PASSWORD }],
      ['unknown role', { phone: '9876543210', password: PASSWORD, role: 'SUPERUSER' }],
      ['invalid email', { email: 'not-an-email', password: PASSWORD }],
      ['both phone and email', { phone: '9876543210', email: 'riya@example.com', password: PASSWORD }],
      ['unknown field', { phone: '9876543210', password: PASSWORD, isAdmin: true }],
      ['numeric phone', { phone: 9876543210, password: PASSWORD }],
      ['numeric password', { phone: '9876543210', password: 123456 }],
      ['array body', [{ phone: '9876543210', password: PASSWORD }]],
    ])('returns 422 for %s', async (_case, body) => {
      const res = await postLogin(app, body)

      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
      expect(res.body.error.details.fields.length).toBeGreaterThan(0)
    })

    it('returns 422 for malformed JSON', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"phone": "98765')

      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('rejects invalid input before any authentication logic runs', async () => {
      await createUser()

      const res = await postLogin(app, { phone: '98765', password: PASSWORD })

      expect(res.status).toBe(422)
      expect(res.body.error).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: { fields: [{ field: 'phone', message: 'Phone must be a 10-digit Indian mobile number' }] },
      })
      // No login attempt was made, so nothing was audited and no session exists
      expect(await db.select().from(auditLogs)).toHaveLength(0)
      expect(await db.select().from(authSessions)).toHaveLength(0)
    })

    it('never echoes the submitted password in validation errors', async () => {
      const res = await postLogin(app, { phone: '123', password: 'my-secret-pass' })

      expect(JSON.stringify(res.body)).not.toContain('my-secret-pass')
    })
  })

  describe('rate limiting', () => {
    it('returns 429 after 5 failed attempts for the same account', async () => {
      await createUser()

      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await postLogin(app, { phone: '9876543210', password: 'wrong-password' })
        expect(res.status).toBe(401)
      }
      const blocked = await postLogin(app, { phone: '9876543210', password: PASSWORD })

      expect(blocked.status).toBe(429)
      expect(blocked.body.error).toMatchObject({ code: 'TOO_MANY_REQUESTS', retryAfterSeconds: 900 })
      expect(blocked.headers['retry-after']).toBe('900')
      const limited = await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'AUTH_LOGIN_RATE_LIMITED'))
      expect(limited).toHaveLength(1)
    })

    it('does not count successful logins toward the limit', async () => {
      await createUser()

      for (let attempt = 0; attempt < 7; attempt++) {
        const res = await postLogin(app, { phone: '9876543210', password: PASSWORD })
        expect(res.status).toBe(200)
      }
    })

    it('limits an account across IPs, so guesses spread over many IPs are capped', async () => {
      await createUser()
      app.set('trust proxy', true)
      const fromIp = (ip: string, password: string) =>
        postLogin(app, { phone: '9876543210', password }).set('X-Forwarded-For', ip)

      // 20 failures spread so that no single IP reaches its own limit of 5
      for (let ip = 1; ip <= 5; ip++) {
        for (let attempt = 0; attempt < 4; attempt++) {
          expect((await fromIp(`203.0.113.${ip}`, 'wrong-password')).status).toBe(401)
        }
      }

      const blocked = await fromIp('203.0.113.99', PASSWORD)
      expect(blocked.status).toBe(429)
      expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS')
    })

    it('rate limits unknown accounts the same way, so 429 does not reveal registration', async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        expect((await postLogin(app, { phone: '9000000000', password: 'wrong-password' })).status).toBe(401)
      }

      const blocked = await postLogin(app, { phone: '9000000000', password: 'wrong-password' })
      expect(blocked.status).toBe(429)
    })

    it('limits each account separately', async () => {
      await createUser()
      await createUser({ phone: '9876543211', email: 'guard@example.com', role: 'GUARD' })

      for (let attempt = 0; attempt < 5; attempt++) {
        await postLogin(app, { phone: '9876543210', password: 'wrong-password' })
      }

      const other = await postLogin(app, { phone: '9876543211', password: PASSWORD })
      expect(other.status).toBe(200)
    })
  })

  describe('sensitive data', () => {
    it('never writes the password to logs, on any login outcome', async () => {
      const lines: string[] = []
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          lines.push(chunk.toString())
          callback()
        },
      })
      const loggedApp = createApp({ logger: createLogger({ level: 'debug' }, sink) })
      await createUser()
      const secret = 'Wrong-Secret-42'

      await postLogin(loggedApp, { phone: '9876543210', password: PASSWORD }) // success
      await postLogin(loggedApp, { phone: '98765', password: secret }) // validation error
      await request(loggedApp)
        .post('/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send(`{"phone": "9876543210", "password": "${secret}"`) // malformed JSON
      for (let attempt = 0; attempt < 6; attempt++) {
        await postLogin(loggedApp, { phone: '9876543210', password: secret }) // failures, then 429
      }

      const output = lines.join('')
      expect(lines.length).toBeGreaterThan(0)
      expect(output).not.toContain(PASSWORD)
      expect(output).not.toContain(secret)
    })


    it('never returns the password hash or refresh token in the body', async () => {
      const user = await createUser()

      const res = await postLogin(app, { phone: '9876543210', password: PASSWORD })
      const body = JSON.stringify(res.body)

      expect(body).not.toMatch(/password/i)
      expect(body).not.toContain(user.passwordHash)
      expect(body).not.toMatch(/refresh/i)
    })
  })
})
