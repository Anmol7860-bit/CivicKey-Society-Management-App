import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
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

/**
 * The same two fields, required. A record that must carry proof of who someone is asks for the
 * whole number: it is stored encrypted, and only its last 4 characters are ever shown again.
 */
export const identityRequired = {
  idDocumentType: identitySchema.idDocumentType.unwrap(),
  idNumber: identitySchema.idNumber.unwrap(),
}

export interface IdentityInput {
  idDocumentType?: (typeof idDocumentType.enumValues)[number] | undefined
  idNumber?: string | undefined
  idDocumentLast4?: string | undefined
}

/** The data-encryption key, as 32 bytes. Startup has already refused to run without a valid one. */
function dataKey() {
  const raw = env.DATA_ENCRYPTION_KEY
  return /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
}

/** base64(nonce || tag || ciphertext): one string per value, with its own nonce. */
function encrypt(value: string) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', dataKey(), nonce)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64')
}

/**
 * The stored number again, for the one authorised, audited read that may see it.
 *
 * The tag is checked by the decipher, so a row someone edited in the database fails here rather
 * than returning a number that was never captured.
 */
export function decryptIdNumber(stored: string | null) {
  if (!stored) return null
  const bytes = Buffer.from(stored, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', dataKey(), bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
}

/**
 * Identity is kept as the document type, the encrypted number, a keyed lookup hash and the last 4
 * digits. The number is recoverable, because a society has to be able to show an authority the
 * document it recorded, but only through the audited read: it is never in an ordinary response or
 * a log. Without a configured pepper the server refuses the full number rather than storing a hash
 * a 12-digit value could be guessed against.
 */
export function identityOf(body: IdentityInput) {
  const columns = { idDocumentType: body.idDocumentType ?? null, idDocumentLast4: body.idDocumentLast4 ?? null }
  if (!body.idNumber) return { ...columns, idDocumentHash: null, idDocumentEncrypted: null }
  assertState(
    env.ID_HASH_PEPPER !== undefined,
    'This server cannot accept a full ID number; send only its last 4 characters',
  )
  return {
    ...columns,
    idDocumentLast4: body.idNumber.slice(-4),
    idDocumentHash: createHmac('sha256', env.ID_HASH_PEPPER!).update(`${body.idDocumentType}:${body.idNumber}`).digest('hex'),
    idDocumentEncrypted: encrypt(body.idNumber),
  }
}

/**
 * The stored ID never leaves in an ordinary response: the hash matches, the ciphertext is the
 * record, and a caller only learns that a document is on file.
 */
export function withoutHash<T extends { idDocumentHash: string | null; idDocumentEncrypted?: string | null }>(row: T) {
  const { idDocumentHash, idDocumentEncrypted, ...rest } = row
  void idDocumentEncrypted
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
