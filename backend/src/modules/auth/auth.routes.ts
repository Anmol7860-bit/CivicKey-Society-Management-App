import { Router, type CookieOptions, type RequestHandler, type Response } from 'express'
import { isProduction } from '../../config/env.js'
import { AppError } from '../../lib/errors.js'
import { requireAuth, requireAuthForLogout } from '../../middleware/requireAuth.js'
import { validateBody } from '../../middleware/validateBody.js'
import { getEffectivePermissions } from '../access/permissions.js'
import { disconnectSession } from '../notification/realtime.js'
import { identifierFrom, loginSchema, type LoginBody } from './auth.schemas.js'
import { login, logout, refreshSession, type AuthResult } from './auth.service.js'
import { forgotPasswordSchema, requestPasswordReset, setPasswordSchema, setPasswordWithCode } from './passwordSetup.js'
import { countRequestFromIp } from './throttle.js'

export const REFRESH_COOKIE_NAME = 'ck_refresh'

const refreshCookieBase: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'strict',
  // Only sent to auth endpoints (refresh, logout)
  path: '/api/v1/auth',
}

export function refreshCookieOptions(expires: Date): CookieOptions {
  return { ...refreshCookieBase, expires }
}

function sendAuthResult(res: Response, result: AuthResult) {
  res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, refreshCookieOptions(result.refreshTokenExpiresAt))
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json({
    data: {
      tokenType: 'Bearer',
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    },
  })
}

/**
 * Counts every auth request against the caller's address, in the database, before anything else
 * runs. It survives a restart, which an in-process counter did not.
 */
const perIp: RequestHandler = async (req, _res, next) => {
  try {
    await countRequestFromIp(req.ip ?? 'unknown', { ipAddress: req.ip ?? null, userAgent: req.get('user-agent') ?? null })
    next()
  } catch (error) {
    next(error)
  }
}

export function createAuthRouter() {
  const router = Router()

  // Order matters: the per-IP cap first, then validation so no auth logic sees bad input. The
  // per-phone failure count lives in the login service, which knows whether the password was right.
  router.post(
    '/login',
    perIp,
    validateBody(loginSchema),
    async (req, res) => {
      const body = req.body as LoginBody
      const result = await login(
        identifierFrom(body),
        body.password,
        { ipAddress: req.ip ?? null, userAgent: req.get('user-agent') ?? null },
        body.role,
      )
      sendAuthResult(res, result)
    },
  )

  /** Someone who cannot sign in asks the office for a code. Always answers the same way. */
  router.post(
    '/forgot-password',
    perIp,
    validateBody(forgotPasswordSchema),
    async (req, res) => {
      const data = await requestPasswordReset(req.body.phone, {
        ipAddress: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      })
      res.setHeader('Cache-Control', 'no-store')
      res.status(200).json({ data })
    },
  )

  /** Spends a one-time code from the office and sets the account's password. */
  router.post('/set-password', perIp, validateBody(setPasswordSchema), async (req, res) => {
    const data = await setPasswordWithCode(req.body, {
      ipAddress: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ data })
  })

  router.post('/refresh', async (req, res) => {
    try {
      const result = await refreshSession(req.cookies?.[REFRESH_COOKIE_NAME], {
        ipAddress: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      })
      sendAuthResult(res, result)
    } catch (error) {
      // A rejected refresh token is useless to the client, so remove it
      if (error instanceof AppError) res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieBase)
      throw error
    }
  })

  router.post('/logout', requireAuthForLogout, async (req, res) => {
    const { userId, sessionId } = req.ctx!
    await logout(userId, sessionId, { ipAddress: req.ip ?? null, userAgent: req.get('user-agent') ?? null })
    // The session is gone; a socket it left open would keep receiving this person's events
    disconnectSession(sessionId)
    res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieBase)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ data: { loggedOut: true } })
  })

  router.get('/permissions', requireAuth, async (req, res) => {
    const result = await getEffectivePermissions(req.ctx!.userId)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ data: result })
  })

  return router
}
