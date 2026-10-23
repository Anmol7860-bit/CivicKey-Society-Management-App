import { Router, type CookieOptions, type Response } from 'express'
import { isProduction } from '../../config/env.js'
import { AppError } from '../../lib/errors.js'
import { requireAuth } from '../../middleware/requireAuth.js'
import { validateBody } from '../../middleware/validateBody.js'
import { getEffectivePermissions } from '../access/permissions.js'
import { identifierFrom, loginSchema, type LoginBody } from './auth.schemas.js'
import { login, logout, refreshSession, type AuthResult } from './auth.service.js'
import { forgotPasswordSchema, requestPasswordReset, setPasswordSchema, setPasswordWithCode } from './passwordSetup.js'
import { createLoginRateLimiters } from './rateLimit.js'

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

export function createAuthRouter() {
  const router = Router()
  const limiters = createLoginRateLimiters()

  // Order matters: the cheap per-IP cap first, then validation so no auth logic sees bad input,
  // then the per-account limits that need the parsed identifier
  router.post(
    '/login',
    limiters.perIp,
    validateBody(loginSchema),
    limiters.perAccount,
    limiters.perIdentifier,
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
    limiters.perIpPasswordSetup,
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
  router.post('/set-password', limiters.perIpPasswordSetup, validateBody(setPasswordSchema), async (req, res) => {
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

  router.post('/logout', requireAuth, async (req, res) => {
    const { userId, sessionId } = req.ctx!
    await logout(userId, sessionId, { ipAddress: req.ip ?? null, userAgent: req.get('user-agent') ?? null })
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
