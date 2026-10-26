import { createApp } from './app.js'
import { env } from './config/env.js'
import { pool } from './db/client.js'
import { logger } from './lib/logger.js'
import { attachRealtime, closeRealtime } from './modules/notification/realtime.js'
import { startBackgroundWork } from './modules/notification/runner.js'

const server = createApp().listen(env.PORT, () => {
  logger.info(`CivicKey API listening on http://localhost:${env.PORT}`)
})

// Live notifications share the HTTP server, so there is one port and one origin to allow
attachRealtime(server)
// The dispatcher and the scheduled jobs run here rather than as a separate process: one deployment
// to run, and both claim their work in the database so a second instance is safe
const stopBackgroundWork = startBackgroundWork()

function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`)
  stopBackgroundWork()
  void closeRealtime()
  server.close(() => {
    pool.end().finally(() => process.exit(0))
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
