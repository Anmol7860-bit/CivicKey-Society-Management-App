import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { createApp } from '../../app.js'
import { env } from '../../config/env.js'
import { db } from '../../db/client.js'
import { backupExportJobs } from '../../db/schema.js'
import { createUser, grantPermissions, TEST_SOCIETY_ID, signTestToken } from '../../test/helpers.js'
import { decryptArchive } from './backup.service.js'

const app = createApp()

let auth: string
let plain: string

const tokenFor = (user: { id: string; role: 'ADMIN' | 'RESIDENT' | 'GUARD' }) =>
  signTestToken({ userId: user.id, role: user.role, societyId: TEST_SOCIETY_ID }).then((t) => `Bearer ${t}`)

/** The dump runs after the response, so the tests wait for the job to settle, briefly. */
async function settled(jobId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [job] = await db.select().from(backupExportJobs).where(eq(backupExportJobs.id, jobId))
    if (job && job.status !== 'PENDING' && job.status !== 'RUNNING') return job
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('The backup job never finished')
}

const api = {
  get: (path: string, token = auth) => request(app).get(`/api/v1${path}`).set('Authorization', token),
  post: (path: string, token = auth) => request(app).post(`/api/v1${path}`).set('Authorization', token).send({}),
}

beforeEach(async () => {
  const admin = await createUser({ phone: '9000000001', email: null, role: 'ADMIN' })
  await grantPermissions(admin.id, ['BACKUP_EXPORT', 'SOCIETY_MANAGE'])
  auth = await tokenFor(admin)

  const other = await createUser({ phone: '9000000002', email: null, role: 'ADMIN' })
  await grantPermissions(other.id, ['SOCIETY_MANAGE'])
  plain = await tokenFor(other)
})

it('needs the permission, whatever else the admin may do', async () => {
  expect((await api.post(`/societies/${TEST_SOCIETY_ID}/backups`, plain)).status).toBe(403)
})

it('dumps the database encrypted, and the archive reads back as SQL', async () => {
  const started = await api.post(`/societies/${TEST_SOCIETY_ID}/backups`)

  expect(started.status).toBe(202)
  expect(started.body.data.status).toBe('PENDING')

  const job = await settled(started.body.data.id)
  expect(job).toMatchObject({ status: 'READY' })
  expect(job!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000)

  const archive = await readFile(join(env.BACKUP_DIR, job!.fileName!))
  const sql = gunzipSync(decryptArchive(archive)).toString()
  expect(sql).toContain('CREATE TABLE')
  expect(sql).toContain('societies')
})

it('hands the archive over once, and never again', async () => {
  const { body } = await api.post(`/societies/${TEST_SOCIETY_ID}/backups`)
  await settled(body.data.id)

  const first = await api.get(`/backups/${body.data.id}/download`)
  expect(first.status).toBe(200)
  expect(first.headers['content-disposition']).toContain('.sql.gz.enc')
  expect(first.headers['cache-control']).toBe('no-store')

  const second = await api.get(`/backups/${body.data.id}/download`)
  expect(second.status).toBe(404)
})

it('refuses a link that has run out of time', async () => {
  const { body } = await api.post(`/societies/${TEST_SOCIETY_ID}/backups`)
  await settled(body.data.id)
  await db
    .update(backupExportJobs)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(backupExportJobs.id, body.data.id))

  expect((await api.get(`/backups/${body.data.id}/download`)).status).toBe(404)
  const [job] = await db.select().from(backupExportJobs).where(eq(backupExportJobs.id, body.data.id))
  expect(job!.status).toBe('EXPIRED')
})

it('records the failure instead of losing it when pg_dump is not there', async () => {
  const real = env.PG_DUMP_PATH
  // The env object is read-only by convention; this stands in for a server without pg_dump
  env.PG_DUMP_PATH = '/nowhere/pg_dump'
  let jobId: string
  try {
    const { body } = await api.post(`/societies/${TEST_SOCIETY_ID}/backups`)
    jobId = body.data.id
    await settled(jobId)
  } finally {
    env.PG_DUMP_PATH = real
  }

  const status = await api.get(`/backups/${jobId}`)
  expect(status.body.data).toMatchObject({ status: 'FAILED', errorCode: 'PG_DUMP_MISSING' })
})

it('does not exist at all in a cloud deployment', async () => {
  const real = env.DEPLOYMENT_MODE
  env.DEPLOYMENT_MODE = 'cloud'
  try {
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/backups`)).status).toBe(404)
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/backups`)).status).toBe(404)
  } finally {
    env.DEPLOYMENT_MODE = real
  }
})
