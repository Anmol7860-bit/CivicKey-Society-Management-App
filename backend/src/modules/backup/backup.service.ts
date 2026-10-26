import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { and, desc, eq } from 'drizzle-orm'
import { env } from '../../config/env.js'
import { db } from '../../db/client.js'
import { backupExportJobs } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { assertSameSociety, assertState, requireRecord, UUID } from '../access/scope.js'
import { recordAuditEvent } from '../audit/audit.service.js'

/** A link is worth nothing fifteen minutes after the archive is ready. */
export const LINK_TTL_MS = 15 * 60 * 1000

const notHere = () => new AppError(404, 'NOT_FOUND', 'Not found')

/** Self-hosted only: a managed deployment has its own backups and must not shell out at all. */
function assertLocalDeployment() {
  if (env.DEPLOYMENT_MODE !== 'local') throw notHere()
}

function key() {
  const raw = env.BACKUP_ENCRYPTION_KEY
  if (!raw) return null
  const bytes = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  return bytes.length === 32 ? bytes : null
}

const fileNameFor = (jobId: string) => `${jobId}.sql.gz.enc`

/**
 * Starts an encrypted dump of the database.
 *
 * The job row is written first and the work happens after the response, so an admin sees
 * generating/ready/failed instead of a request that hangs for a minute. A missing key or a
 * missing pg_dump is a failure an admin can see, not a silent nothing.
 */
export async function requestBackup(ctx: AuthContext, societyId: string) {
  assertLocalDeployment()
  await assertSameSociety(ctx, societyId)

  const [job] = await db
    .insert(backupExportJobs)
    .values({ societyId, requestedBy: ctx.userId })
    .returning()
  await recordAuditEvent(db, {
    eventType: 'BACKUP_EXPORT_REQUESTED',
    actorUserId: ctx.userId,
    metadata: { societyId, jobId: job!.id },
  })

  if (!key()) {
    await fail(job!.id, 'MISSING_ENCRYPTION_KEY')
    throw new AppError(503, 'STORAGE_ERROR', 'Backups are not configured on this server.')
  }
  // The dump runs on its own; the admin polls the job
  void runBackupJob(job!.id).catch((error: unknown) => logger.error({ err: error, jobId: job!.id }, 'A backup failed'))
  return describe(job!)
}

async function fail(jobId: string, errorCode: string) {
  await db
    .update(backupExportJobs)
    .set({ status: 'FAILED', errorCode, completedAt: new Date() })
    .where(eq(backupExportJobs.id, jobId))
}

/**
 * Runs pg_dump into a gzipped, AES-256-GCM encrypted file.
 *
 * Every argument is written here and none comes from the request: a backup must never be a way to
 * run something else. The archive is nonce || tag || ciphertext, the same shape as everything else
 * this server encrypts, and it lives in a private directory that nothing serves.
 */
export async function runBackupJob(jobId: string) {
  const secret = key()
  if (!secret) return fail(jobId, 'MISSING_ENCRYPTION_KEY')

  const claimed = await db
    .update(backupExportJobs)
    .set({ status: 'RUNNING' })
    .where(and(eq(backupExportJobs.id, jobId), eq(backupExportJobs.status, 'PENDING')))
    .returning()
  if (claimed.length === 0) return

  const path = join(env.BACKUP_DIR, fileNameFor(jobId))
  try {
    await mkdir(env.BACKUP_DIR, { recursive: true })
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', secret, nonce)
    const dump = spawn(env.PG_DUMP_PATH, ['--no-owner', '--no-privileges', '--dbname', env.DATABASE_URL], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    dump.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const out = createWriteStream(path)
    // The nonce goes in front, then the tag's place is filled in once the cipher has finished
    out.write(Buffer.concat([nonce, Buffer.alloc(16)]))

    const exited = new Promise<void>((resolve, reject) => {
      dump.on('error', reject)
      dump.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-300) || `pg_dump exited ${code}`))))
    })
    await Promise.all([pipeline(dump.stdout, createGzip(), cipher, out), exited])

    // Write the authentication tag into the 16 bytes reserved for it
    const handle = await (await import('node:fs/promises')).open(path, 'r+')
    await handle.write(cipher.getAuthTag(), 0, 16, 12)
    await handle.close()

    const { size } = await stat(path)
    await db
      .update(backupExportJobs)
      .set({
        status: 'READY',
        fileName: fileNameFor(jobId),
        byteSize: size,
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + LINK_TTL_MS),
      })
      .where(eq(backupExportJobs.id, jobId))
  } catch (error) {
    await unlink(path).catch(() => {})
    logger.error({ err: error, jobId }, 'pg_dump could not produce a backup')
    await fail(jobId, String(error).includes('ENOENT') ? 'PG_DUMP_MISSING' : 'DUMP_FAILED')
  }
}

const describe = (job: typeof backupExportJobs.$inferSelect) => ({
  id: job.id,
  status: job.status,
  byteSize: job.byteSize,
  errorCode: job.errorCode,
  createdAt: job.createdAt,
  completedAt: job.completedAt,
  expiresAt: job.expiresAt,
  downloadedAt: job.downloadedAt,
})

async function load(ctx: AuthContext, jobId: string) {
  assertLocalDeployment()
  const [job] = UUID.test(jobId) ? await db.select().from(backupExportJobs).where(eq(backupExportJobs.id, jobId)) : []
  await requireRecord(ctx, job, 'Backup')
  return job!
}

export async function backupStatus(ctx: AuthContext, jobId: string) {
  return describe(await load(ctx, jobId))
}

export async function listBackups(ctx: AuthContext, societyId: string) {
  assertLocalDeployment()
  await assertSameSociety(ctx, societyId)
  const rows = await db
    .select()
    .from(backupExportJobs)
    .where(eq(backupExportJobs.societyId, societyId))
    .orderBy(desc(backupExportJobs.createdAt))
    .limit(20)
  return rows.map(describe)
}

/**
 * Hands over the archive exactly once, and only inside the fifteen minutes.
 *
 * The claim is an update guarded by the download time, so two requests racing for the same link
 * cannot both win it. The caller's permission is checked again by the route that gets here, since
 * a link is not an authorisation.
 */
export async function downloadBackup(ctx: AuthContext, jobId: string) {
  const job = await load(ctx, jobId)
  // A spent link is gone, not broken: say so rather than describing the job's state
  if (job.downloadedAt) throw new AppError(404, 'NOT_FOUND', 'That download link has already been used.')
  assertState(job.status === 'READY', 'That backup is not ready')
  if (!job.expiresAt || job.expiresAt.getTime() < Date.now()) {
    await db.update(backupExportJobs).set({ status: 'EXPIRED' }).where(eq(backupExportJobs.id, jobId))
    throw new AppError(404, 'NOT_FOUND', 'That download link has expired. Ask for a new backup.')
  }

  const claimed = await db
    .update(backupExportJobs)
    .set({ downloadedAt: new Date(), status: 'EXPIRED' })
    .where(and(eq(backupExportJobs.id, jobId), eq(backupExportJobs.status, 'READY')))
    .returning({ fileName: backupExportJobs.fileName })
  if (claimed.length === 0) throw new AppError(404, 'NOT_FOUND', 'That download link has already been used.')

  await recordAuditEvent(db, {
    eventType: 'BACKUP_EXPORT_DOWNLOADED',
    actorUserId: ctx.userId,
    metadata: { societyId: job.societyId, jobId },
  })
  try {
    return { fileName: `civickey-backup-${jobId}.sql.gz.enc`, bytes: await readFile(join(env.BACKUP_DIR, claimed[0]!.fileName!)) }
  } catch {
    throw new AppError(503, 'STORAGE_ERROR', 'That backup file is no longer on this server.')
  }
}

/**
 * Reads an archive back, for the operator who has to restore one.
 *
 * It is exported so the restore path is tested rather than discovered during an emergency:
 * `gunzip` on the plaintext gives the file pg_restore wants.
 */
export function decryptArchive(bytes: Buffer, secret = key()) {
  if (!secret) throw new AppError(503, 'STORAGE_ERROR', 'Backups are not configured on this server.')
  const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
}
