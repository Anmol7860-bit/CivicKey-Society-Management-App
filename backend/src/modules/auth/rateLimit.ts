import type { Request } from 'express'
import { ipKeyGenerator, rateLimit, type Options } from 'express-rate-limit'
import { env } from '../../config/env.js'
import { db } from '../../db/client.js'
import { AppError } from '../../lib/errors.js'
import { maskIdentifier, recordAuditEvent } from '../audit/audit.service.js'
import { identifierFrom, type LoginBody } from './auth.schemas.js'

const windowMs = env.LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000

function clientIp(req: Request) {
  return ipKeyGenerator(req.ip ?? 'unknown')
}

const rejectWith429: Options['handler'] = async (req, _res, next, options) => {
  const retryAfterSeconds = Math.ceil(options.windowMs / 1000)
  const body = req.body as Partial<LoginBody> | undefined
  const identifier = body?.phone || body?.email ? identifierFrom(body as LoginBody) : null

  try {
    await recordAuditEvent(db, {
      eventType: 'AUTH_LOGIN_RATE_LIMITED',
      ipAddress: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      metadata: identifier
        ? { identifierType: identifier.type, identifier: maskIdentifier(identifier.type, identifier.value) }
        : {},
    })
  } catch (error) {
    req.log.error({ err: error }, 'Failed to audit rate-limited login')
  }

  next(
    new AppError(429, 'TOO_MANY_REQUESTS', 'Too many login attempts. Try again later.', { retryAfterSeconds }),
  )
}

/**
 * Login rate limits. Created per app instance so tests start clean.
 * In-memory store for now; switch to a Redis store when running more than one API instance.
 */
export function createLoginRateLimiters() {
  // Broad per-IP cap on all login requests, including malformed ones
  const perIp = rateLimit({
    windowMs,
    limit: env.LOGIN_RATE_LIMIT_MAX * 10,
    keyGenerator: clientIp,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rejectWith429,
  })

  // Failed attempts per account + IP. Runs after validation, so the body is parsed.
  const perAccount = rateLimit({
    windowMs,
    limit: env.LOGIN_RATE_LIMIT_MAX,
    keyGenerator: (req) => {
      const identifier = identifierFrom(req.body as LoginBody)
      return `${clientIp(req)}:${identifier.type}:${identifier.value}`
    },
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rejectWith429,
  })

  // Failed attempts per account from any IP, so spreading guesses over many IPs doesn't help.
  // Looser than perAccount because hitting it also locks out the real user for the window.
  const perIdentifier = rateLimit({
    windowMs,
    limit: env.LOGIN_RATE_LIMIT_MAX * 4,
    keyGenerator: (req) => {
      const identifier = identifierFrom(req.body as LoginBody)
      return `${identifier.type}:${identifier.value}`
    },
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rejectWith429,
  })

  return { perIp, perAccount, perIdentifier }
}
