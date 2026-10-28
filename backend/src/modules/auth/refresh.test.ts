import { Writable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { decodeJwt, jwtVerify } from 'jose'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { auditLogs, authSessions, refreshTokens, users } from '../../db/schema.js'
import { createLogger } from '../../lib/logger.js'
import {
  PASSWORD,
  createUser,
  postLogin,
  postRefresh,
  refreshCookie,
  refreshTokenFrom,
  type App,
} from '../../test/helpers.js'
import { hashRefreshToken } from './tokens.js'

async function loginAndGetToken(app: App) {
  const res = await postLogin(app, { phone: '9876543210', password: PASSWORD })
  expect(res.status).toBe(200)
  return { token: refreshTokenFrom(res), accessToken: res.body.data.accessToken as string }
}

function expectCookieCleared(res: Awaited<ReturnType<typeof postRefresh>>) {
  const cookie = refreshCookie(res)
  expect(cookie).toBeDefined()
  expect(cookie).toMatch(/^ck_refresh=;/)
  expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/)
}

describe('POST /api/v1/auth/refresh', () => {
  let app: App

  beforeEach(() => {
    app = createApp()
  })

  describe('valid refresh token', () => {
    it('returns 200 with a new access token for the same session', async () => {
      const user = await createUser()
      const { token, accessToken } = await loginAndGetToken(app)

      const res = await postRefresh(app, token)

      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.body.data).toMatchObject({
        tokenType: 'Bearer',
        expiresIn: 21600,
        user: { id: user.id, role: 'RESIDENT', societyId: user.societyId },
      })

      const { payload } = await jwtVerify(
        res.body.data.accessToken,
        new TextEncoder().encode(process.env.JWT_ACCESS_SECRET),
        { issuer: 'civickey-api', audience: 'civickey-app' },
      )
      expect(payload).toMatchObject({ sub: user.id, role: 'RESIDENT', sid: decodeJwt(accessToken).sid })
    })

    it('rotates the refresh token and persists only the new hash', async () => {
      await createUser()
      const { token: oldToken } = await loginAndGetToken(app)

      const res = await postRefresh(app, oldToken)
      const newToken = refreshTokenFrom(res)

      expect(newToken).not.toBe(oldToken)
      expect(refreshCookie(res)).toMatch(/HttpOnly/)
      expect(JSON.stringify(res.body)).not.toContain(newToken)

      const tokens = await db.select().from(refreshTokens).orderBy(refreshTokens.createdAt)
      const oldRow = tokens.find((row) => row.tokenHash === hashRefreshToken(oldToken))
      const newRow = tokens.find((row) => row.tokenHash === hashRefreshToken(newToken))

      expect(tokens).toHaveLength(2)
      expect(oldRow).toMatchObject({ replacedById: newRow!.id, revokedAt: null })
      expect(oldRow!.rotatedAt).toBeInstanceOf(Date)
      expect(newRow).toMatchObject({ rotatedAt: null, revokedAt: null, sessionId: oldRow!.sessionId })
      expect(tokens.some((row) => row.tokenHash === oldToken || row.tokenHash === newToken)).toBe(false)

      const [session] = await db.select().from(authSessions)
      expect(session!.lastUsedAt).toBeInstanceOf(Date)
      expect(session!.expiresAt.getTime()).toBe(newRow!.expiresAt.getTime())
    })

    it('lets each new token be used for the next refresh', async () => {
      await createUser()
      let { token } = await loginAndGetToken(app)

      for (let round = 0; round < 3; round++) {
        const res = await postRefresh(app, token)
        expect(res.status).toBe(200)
        token = refreshTokenFrom(res)
      }

      expect(await db.select().from(refreshTokens)).toHaveLength(4)
    })
  })

  describe('rejected tokens', () => {
    it('returns 401 when no refresh cookie is sent', async () => {
      const res = await postRefresh(app)

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN')
    })

    it('returns 401 and clears the cookie for an unknown token', async () => {
      const res = await postRefresh(app, 'not-a-real-token')

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN')
      expectCookieCleared(res)
      const [event] = await db.select().from(auditLogs)
      expect(event).toMatchObject({ eventType: 'AUTH_REFRESH_FAILED', metadata: { reason: 'UNKNOWN_TOKEN' } })
    })

    it('returns 401 SESSION_EXPIRED for an expired token', async () => {
      await createUser()
      const { token } = await loginAndGetToken(app)
      await db
        .update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(refreshTokens.tokenHash, hashRefreshToken(token)))

      const res = await postRefresh(app, token)

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('SESSION_EXPIRED')
      expectCookieCleared(res)
      const failures = await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'AUTH_REFRESH_FAILED'))
      expect(failures[0]!.metadata.reason).toBe('EXPIRED')
    })

    it('returns 401 for a token whose session was revoked', async () => {
      await createUser()
      const { token } = await loginAndGetToken(app)
      await db.update(authSessions).set({ revokedAt: new Date(), revokedReason: 'LOGOUT' })

      const res = await postRefresh(app, token)

      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN')
      expectCookieCleared(res)
      const failures = await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'AUTH_REFRESH_FAILED'))
      expect(failures[0]!.metadata.reason).toBe('SESSION_REVOKED')
    })

    it('returns 403 and ends the session when the user was deactivated', async () => {
      const user = await createUser()
      const { token } = await loginAndGetToken(app)
      await db.update(users).set({ isActive: false }).where(eq(users.id, user.id))

      const res = await postRefresh(app, token)

      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('USER_INACTIVE')
      const [session] = await db.select().from(authSessions)
      expect(session).toMatchObject({ revokedReason: 'USER_INACTIVE' })
    })
  })

  describe('reuse detection', () => {
    it('revokes the whole session when an already-rotated token is used again', async () => {
      const user = await createUser()
      const { token: first } = await loginAndGetToken(app)
      const rotated = await postRefresh(app, first)
      const second = refreshTokenFrom(rotated)

      const reuse = await postRefresh(app, first)

      expect(reuse.status).toBe(401)
      expect(reuse.body.error.code).toBe('INVALID_REFRESH_TOKEN')
      expectCookieCleared(reuse)

      const [session] = await db.select().from(authSessions)
      expect(session!.revokedAt).toBeInstanceOf(Date)
      expect(session!.revokedReason).toBe('REFRESH_TOKEN_REUSE')
      const tokens = await db.select().from(refreshTokens)
      expect(tokens.every((row) => row.revokedAt instanceof Date)).toBe(true)

      const [event] = await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'AUTH_REFRESH_REUSE_DETECTED'))
      expect(event).toMatchObject({ actorUserId: user.id, metadata: { sessionId: session!.id } })

      // The latest token in the family no longer works either
      const afterReuse = await postRefresh(app, second)
      expect(afterReuse.status).toBe(401)
    })

    it('does not affect the user’s other sessions', async () => {
      await createUser()
      const { token: phoneSession } = await loginAndGetToken(app)
      const { token: laptopSession } = await loginAndGetToken(app)

      await postRefresh(app, phoneSession)
      await postRefresh(app, phoneSession)

      const laptop = await postRefresh(app, laptopSession)
      expect(laptop.status).toBe(200)
    })

    it('allows only one of two concurrent refreshes with the same token', async () => {
      await createUser()
      const { token } = await loginAndGetToken(app)

      const results = await Promise.all([postRefresh(app, token), postRefresh(app, token)])

      expect(results.map((res) => res.status).sort()).toEqual([200, 401])
    })
  })

  describe('logging', () => {
    it('never writes raw refresh tokens to logs', async () => {
      const lines: string[] = []
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          lines.push(chunk.toString())
          callback()
        },
      })
      const loggedApp = createApp({ logger: createLogger({ level: 'debug' }, sink) })
      await createUser()

      const login = await postLogin(loggedApp, { phone: '9876543210', password: PASSWORD })
      const firstToken = refreshTokenFrom(login)
      const refreshed = await postRefresh(loggedApp, firstToken)
      const secondToken = refreshTokenFrom(refreshed)
      await postRefresh(loggedApp, firstToken)

      const output = lines.join('')
      expect(lines.length).toBeGreaterThan(0)
      expect(output).toContain('[REDACTED]')
      expect(output).not.toContain(firstToken)
      expect(output).not.toContain(secondToken)
      expect(output).not.toContain(PASSWORD)
    })
  })
})
