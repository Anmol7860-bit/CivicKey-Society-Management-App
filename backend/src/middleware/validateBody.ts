import type { RequestHandler } from 'express'
import type { z } from 'zod'
import { AppError } from '../lib/errors.js'

/** Parses any part of a request, or throws 422 VALIDATION_ERROR. */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {})
  if (!result.success) {
    // Only field paths and messages are returned, never the submitted values
    const fields = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    }))
    throw new AppError(422, 'VALIDATION_ERROR', 'Request validation failed', { details: { fields } })
  }
  return result.data
}

/** Replaces req.body with the parsed value, or responds 422 VALIDATION_ERROR. */
export function validateBody(schema: z.ZodType): RequestHandler {
  return (req, _res, next) => {
    req.body = parseOrThrow(schema, req.body)
    next()
  }
}
