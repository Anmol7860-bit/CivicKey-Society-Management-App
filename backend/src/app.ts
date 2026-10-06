import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import type { Logger } from 'pino'
import { pinoHttp } from 'pino-http'
import { env } from './config/env.js'
import { logger as defaultLogger } from './lib/logger.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { createAuthRouter } from './modules/auth/auth.routes.js'

export interface AppOptions {
  logger?: Logger
}

export function createApp({ logger = defaultLogger }: AppOptions = {}) {
  const app = express()

  app.set('trust proxy', env.TRUST_PROXY)
  app.disable('x-powered-by')

  app.use(pinoHttp({ logger }))
  app.use(helmet())
  app.use(cors({ origin: env.CORS_ORIGIN.split(','), credentials: true }))
  app.use(express.json({ limit: '10kb' }))
  app.use(cookieParser())

  app.get('/api/v1/health', (_req, res) => {
    res.json({ data: { status: 'ok' } })
  })
  app.use('/api/v1/auth', createAuthRouter())

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
