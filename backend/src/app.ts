import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import type { Logger } from 'pino'
import { pinoHttp } from 'pino-http'
import { env } from './config/env.js'
import { logger as defaultLogger } from './lib/logger.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { createAuditRouter } from './modules/audit/audit.routes.js'
import { createAuthRouter } from './modules/auth/auth.routes.js'
import { createBillingRouter } from './modules/billing/billing.routes.js'
import { createFileRouter } from './modules/file/file.routes.js'
import { createGateRouter } from './modules/gate/gate.routes.js'
import { createNotificationRouter } from './modules/notification/notification.routes.js'
import { createResidentRouter } from './modules/resident/resident.routes.js'
import { createSocietyRouter } from './modules/society/society.routes.js'
import { createTaskRouter } from './modules/task/task.routes.js'
import { createStaffRouter } from './modules/staff/staff.routes.js'
import { createSyncRouter } from './modules/sync/sync.routes.js'

const REQUEST_ID_PATTERN = /^[\w-]{1,64}$/

/** Reuses a well-formed X-Request-Id from the caller, otherwise generates one, and echoes it back. */
function requestId(req: IncomingMessage, res: ServerResponse) {
  const incoming = req.headers['x-request-id']
  const id = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID()
  res.setHeader('X-Request-Id', id)
  return id
}

export interface AppOptions {
  logger?: Logger
}

export function createApp({ logger = defaultLogger }: AppOptions = {}) {
  const app = express()

  app.set('trust proxy', env.TRUST_PROXY)
  app.disable('x-powered-by')

  app.use(pinoHttp({ logger, genReqId: requestId }))
  app.use(helmet())
  app.use(cors({ origin: env.CORS_ORIGIN.split(','), credentials: true }))
  // A guard's offline batch is up to 50 recorded events, well past what the rest of the API sends.
  // It is registered first because the parser that runs first decides the limit.
  app.use('/api/v1/sync', express.json({ limit: '512kb' }))
  // The gateway's signature covers the exact bytes it sent, so this one path keeps them
  app.use('/api/v1/payments/razorpay/webhook', express.raw({ type: '*/*', limit: '100kb' }))
  app.use(express.json({ limit: '10kb' }))
  app.use(cookieParser())

  app.get('/api/v1/health', (_req, res) => {
    res.json({ data: { status: 'ok' } })
  })
  app.use('/api/v1/auth', createAuthRouter())
  app.use('/api/v1', createSocietyRouter())
  app.use('/api/v1', createResidentRouter())
  app.use('/api/v1', createStaffRouter())
  app.use('/api/v1', createBillingRouter())
  app.use('/api/v1', createGateRouter())
  app.use('/api/v1', createTaskRouter())
  app.use('/api/v1', createAuditRouter())
  app.use('/api/v1', createSyncRouter())
  app.use('/api/v1', createNotificationRouter())
  app.use('/api/v1', createFileRouter())

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
