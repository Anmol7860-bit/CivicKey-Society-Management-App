import { createApp } from './app.js'
import { env } from './config/env.js'
import { pool } from './db/client.js'
import { logger } from './lib/logger.js'

const server = createApp().listen(env.PORT, () => {
  logger.info(`CivicKey API listening on http://localhost:${env.PORT}`)
})

function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`)
  server.close(() => {
    pool.end().finally(() => process.exit(0))
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
