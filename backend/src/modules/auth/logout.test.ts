import { eq } from 'drizzle-orm'
import { decodeJwt } from 'jose'
import request from 'supertest'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { auditLogs, authSessions, refreshTokens } from '../../db/schema.js'
import { PASSWORD, createUser, postLogin, postRefresh, refreshCookie, refreshTokenFrom, type App } from '../../test/helpers.js'

function postLogout(app: App, accessToken?: string) {
  const req = request(app).post('/api/v1/auth/logout').set('User-Agent', 'vitest')
  return accessToken === undefined ? req : req.set('Authorization', `Bearer ${accessToken}`)
}

async function signIn(app: App) {
  const res = await postLogin(app, { phone: '9876543210', password: PASSWORD })
  expect(res.status).toBe(200)
  const accessToken = res.body.data.accessToken as string
  return { accessToken, refreshToken: refreshTokenFrom(res), sessionId: decodeJwt(accessToken).sid as string }
}

async function logoutEvents() {
  return db.select().from(auditLogs).where(eq(auditLogs.eventType, 'AUTH_LOGOUT'))
}

describe('POST /api/v1/auth/logout', () => {
  let app: App

  beforeEach(() => {
    app = createApp()
  })

  it('revokes the session and all its refresh tokens, and clears the cookie', async () => {
    await createUser()
    const { accessToken, sessionId } = await signIn(app)

    const res = await postLogout(app, accessToken)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: { loggedOut: true } })
    expect(res.headers['cache-control']).toBe('no-store')
    expect(refreshCookie(res)).toMatch(/^ck_refresh=;.*Expires=Thu, 01 Jan 1970/)

    const [session] = await db.select().from(authSessions).where(eq(authSessions.id, sessionId))
    expect(session!.revokedAt).toBeInstanceOf(Date)
    expect(session!.revokedReason).toBe('LOGOUT')
    const tokens = await db.select().from(refreshTokens).where(eq(refreshTokens.sessionId, sessionId))
    expect(tokens.every((token) => token.revokedAt)).toBe(true)
  })

  it('stops the logged-out refresh token from being used', async () => {
    await createUser()
    const { accessToken, refreshToken } = await signIn(app)
    await postLogout(app, accessToken)

    const res = await postRefresh(app, refreshToken)

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN')
  })

  it('records one AUTH_LOGOUT audit event without tokens', async () => {
    const user = await createUser()
    const { accessToken, refreshToken, sessionId } = await signIn(app)

    await postLogout(app, accessToken)

    const events = await logoutEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actorUserId: user.id, userAgent: 'vitest', metadata: { sessionId } })
    expect(JSON.stringify(events[0])).not.toContain(refreshToken)
    expect(JSON.stringify(events[0])).not.toContain(accessToken)
  })

  it('is idempotent: a repeated logout succeeds and changes nothing', async () => {
    await createUser()
    const { accessToken, sessionId } = await signIn(app)
    await postLogout(app, accessToken)
    const [before] = await db.select().from(authSessions).where(eq(authSessions.id, sessionId))

    const res = await postLogout(app, accessToken)

    expect(res.status).toBe(200)
    const [after] = await db.select().from(authSessions).where(eq(authSessions.id, sessionId))
    expect(after).toEqual(before)
    expect(await logoutEvents()).toHaveLength(1)
  })

  it('leaves the user’s other sessions signed in', async () => {
    await createUser()
    const phone = await signIn(app)
    const laptop = await signIn(app)

    await postLogout(app, phone.accessToken)

    const res = await postRefresh(app, laptop.refreshToken)
    expect(res.status).toBe(200)
  })

  it('returns 401 TOKEN_MISSING without an access token', async () => {
    const res = await postLogout(app)

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('TOKEN_MISSING')
  })
})
