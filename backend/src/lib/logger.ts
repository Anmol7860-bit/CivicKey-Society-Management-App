import { pino, type DestinationStream, type LoggerOptions } from 'pino'
import { env, isProduction } from '../config/env.js'

/** Secrets must never reach logs (FR-AUTH-10) */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'passwordHash',
  '*.passwordHash',
]

export const loggerOptions: LoggerOptions = {
  level: env.NODE_ENV === 'test' ? 'silent' : isProduction ? 'info' : 'debug',
  redact: { paths: redactPaths, censor: '[REDACTED]' },
}

/** Builds a logger with the app's redaction rules; tests pass their own destination. */
export function createLogger(options: LoggerOptions = {}, destination?: DestinationStream) {
  return pino({ ...loggerOptions, ...options }, destination)
}

export const logger = createLogger(
  env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {},
)
