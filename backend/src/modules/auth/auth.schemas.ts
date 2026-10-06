import { z } from 'zod'

/**
 * POST /auth/login body. Exactly one login identifier (phone or email) is required,
 * since the final identifier is still an open decision in the auth story.
 */
export const loginSchema = z
  .object({
    phone: z
      .string()
      .trim()
      .regex(/^\d{10}$/, 'Phone must be a 10-digit number')
      .optional(),
    email: z.email('Email must be a valid email address').trim().toLowerCase().max(254).optional(),
    password: z
      .string({ error: 'Password is required' })
      .min(1, 'Password is required')
      .max(128, 'Password is too long'),
  })
  .strict()
  .refine((body) => Boolean(body.phone) !== Boolean(body.email), {
    message: 'Provide either phone or email',
    path: ['phone'],
  })

export type LoginBody = z.infer<typeof loginSchema>

export type LoginIdentifier = { type: 'phone'; value: string } | { type: 'email'; value: string }

export function identifierFrom(body: LoginBody): LoginIdentifier {
  return body.phone ? { type: 'phone', value: body.phone } : { type: 'email', value: body.email! }
}
