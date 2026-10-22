import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { idDocumentType } from '../../db/schema.js'
import { env } from '../../config/env.js'
import { assertState } from './scope.js'

/** The identity fields any person record collects, resident or staff. */
export const identitySchema = {
  idDocumentType: z.enum(idDocumentType.enumValues).optional(),
  /**
   * The full ID number, kept only as a keyed hash plus its last 4 digits. Send `idDocumentLast4`
   * instead when the number itself must not leave the Admin's hands.
   */
  idNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9A-Z]{6,20}$/, 'The ID number must be 6 to 20 letters or digits')
    .optional(),
  idDocumentLast4: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9A-Z]{4}$/, 'Send only the last 4 characters of the document number')
    .optional(),
}

export interface IdentityInput {
  idDocumentType?: (typeof idDocumentType.enumValues)[number] | undefined
  idNumber?: string | undefined
  idDocumentLast4?: string | undefined
}

/**
 * Identity is kept as the document type, a keyed hash and the last 4 digits; the number itself is
 * never stored, returned or logged. Without a configured pepper the server refuses the full number
 * rather than storing a hash a 12-digit value could be guessed against.
 */
export function identityOf(body: IdentityInput) {
  const columns = { idDocumentType: body.idDocumentType ?? null, idDocumentLast4: body.idDocumentLast4 ?? null }
  if (!body.idNumber) return { ...columns, idDocumentHash: null }
  assertState(
    env.ID_HASH_PEPPER !== undefined,
    'This server cannot accept a full ID number; send only its last 4 characters',
  )
  return {
    ...columns,
    idDocumentLast4: body.idNumber.slice(-4),
    idDocumentHash: createHmac('sha256', env.ID_HASH_PEPPER!).update(`${body.idDocumentType}:${body.idNumber}`).digest('hex'),
  }
}

/** The ID hash is stored for matching, never served: callers only learn whether one is on file. */
export function withoutHash<T extends { idDocumentHash: string | null }>(row: T) {
  const { idDocumentHash, ...rest } = row
  return { ...rest, idDocumentOnFile: idDocumentHash !== null }
}

/** Both refinements that keep the type, the number and its last 4 in step. */
export const identityRefinements = <T extends IdentityInput>(schema: z.ZodType<T>) =>
  schema
    .refine((body) => (body.idDocumentLast4 ?? body.idNumber) === undefined || body.idDocumentType !== undefined, {
      message: 'Give the document type as well',
      path: ['idDocumentType'],
    })
    .refine((body) => !body.idNumber || !body.idDocumentLast4 || body.idNumber.endsWith(body.idDocumentLast4), {
      message: 'The last 4 characters do not match the ID number',
      path: ['idDocumentLast4'],
    })
