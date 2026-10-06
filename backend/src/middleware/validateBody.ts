import type { RequestHandler } from 'express'
import type { z } from 'zod'
import { AppError } from '../lib/errors.js'

/** Replaces req.body with the parsed value, or responds 422 VALIDATION_ERROR. */
export function validateBody(schema: z.ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {})
    if (!result.success) {
      // Only field paths and messages are returned, never the submitted values
      const fields = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      }))
      throw new AppError(422, 'VALIDATION_ERROR', 'Request validation failed', { details: { fields } })
    }
    req.body = result.data
    next()
  }
}
