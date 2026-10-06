import type { ErrorRequestHandler, RequestHandler } from 'express'
import { AppError } from '../lib/errors.js'

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'Route not found'))
}

function isJsonParseError(error: unknown) {
  return (
    error instanceof SyntaxError &&
    (error as SyntaxError & { type?: string }).type === 'entity.parse.failed'
  )
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (isJsonParseError(error)) {
    res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' } })
    return
  }

  if (error instanceof AppError) {
    if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds))
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      },
    })
    return
  }

  // Unexpected: log the detail server-side, return nothing internal to the client
  req.log.error({ err: error }, 'Unhandled error')
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } })
}
