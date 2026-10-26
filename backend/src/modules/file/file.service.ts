import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { env } from '../../config/env.js'
import { db } from '../../db/client.js'
import { storedFiles } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { EXTENSIONS, sniff, stripMetadata } from './strip.js'

export const MAX_BYTES = 5 * 1024 * 1024

/** Where the bytes live: a private directory, never served as static files. */
const directory = env.FILE_STORAGE_DIR

const EXTENSION: Record<string, string> = { ...EXTENSIONS, 'application/pdf': 'pdf' }

const fileName = (id: string, contentType: string) => `${id}.${EXTENSION[contentType] ?? 'bin'}`

/**
 * Writes bytes this server produced, such as a rendered receipt, into the same private store.
 *
 * Nothing is sniffed or stripped here: the content type is the one this code chose. Uploads from
 * outside go through saveImage, which trusts neither.
 */
export async function storeBytes(societyId: string, contentType: string, bytes: Buffer) {
  const id = crypto.randomUUID()
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, fileName(id, contentType)), bytes, { flag: 'wx' })
  } catch (cause) {
    throw new AppError(503, 'STORAGE_ERROR', 'The file could not be stored.', { details: String(cause) })
  }
  const [row] = await db
    .insert(storedFiles)
    .values({ id, societyId, contentType, byteSize: bytes.length })
    .returning({ id: storedFiles.id })
  return row!.id
}

/**
 * Stores an uploaded image and returns the reference other records keep.
 *
 * The declared content type is ignored: the bytes decide, so a renamed executable is a 400 rather
 * than a file on disk. The row is written only after the file is on disk, so no record points at
 * a photo that was never saved.
 */
export async function saveImage(ctx: AuthContext, bytes: Buffer) {
  if (!ctx.societyId) throw new AppError(403, 'PERMISSION_DENIED', 'An upload belongs to a society.')
  if (bytes.length === 0) throw new AppError(400, 'INVALID_FILE', 'The upload was empty.')
  if (bytes.length > MAX_BYTES) throw new AppError(413, 'INVALID_FILE', 'An image may be at most 5 MB.')

  const contentType = sniff(bytes)
  if (!contentType) throw new AppError(400, 'INVALID_FILE', 'Only JPEG, PNG and WebP images are accepted.')

  const clean = stripMetadata(bytes, contentType)
  const id = crypto.randomUUID()
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, fileName(id, contentType)), clean, { flag: 'wx' })
  } catch (cause) {
    throw new AppError(503, 'STORAGE_ERROR', 'The image could not be stored. Try again.', { details: String(cause) })
  }

  const [row] = await db
    .insert(storedFiles)
    .values({ id, societyId: ctx.societyId, uploadedBy: ctx.userId, contentType, byteSize: clean.length })
    .returning({ id: storedFiles.id, contentType: storedFiles.contentType, byteSize: storedFiles.byteSize })
  return row!
}

/** The stored row, or a 404, for a reference claimed by a record in this society. */
export async function requireFile(societyId: string | null, id: string) {
  if (!societyId || !/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'NOT_FOUND', 'That image does not exist.')
  const [row] = await db
    .select()
    .from(storedFiles)
    .where(and(eq(storedFiles.id, id), eq(storedFiles.societyId, societyId)))
    .limit(1)
  if (!row) throw new AppError(404, 'NOT_FOUND', 'That image does not exist.')
  return row
}

/** Any stored file, images and generated PDFs alike. */
export async function readStoredFile(societyId: string | null, id: string) {
  const row = await requireFile(societyId, id)
  try {
    return { contentType: row.contentType, bytes: await readFile(join(directory, fileName(row.id, row.contentType))) }
  } catch (cause) {
    throw new AppError(503, 'STORAGE_ERROR', 'The image could not be read.', { details: String(cause) })
  }
}
