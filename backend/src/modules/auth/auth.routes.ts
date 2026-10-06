import { Router, type CookieOptions, type Response } from 'express'
import { isProduction } from '../../config/env.js'
import { AppError } from '../../lib/errors.js'
import { validateBody } from '../../middleware/validateBody.js'
import { identifierFrom, loginSchema, type LoginBody } from './auth.schemas.js'
import { login, refreshSession, type AuthResult } from './auth.service.js'
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

  router.post('/login', limiters.perIp, validateBody(loginSchema), limiters.perAccount, async (req, res) => {
    const body = req.body as LoginBody
    const result = await login(identifierFrom(body), body.password, {
      ipAddress: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    })
    sendAuthResult(res, result)
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

  return router
}
