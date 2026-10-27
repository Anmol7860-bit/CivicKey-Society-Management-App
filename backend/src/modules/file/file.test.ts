import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import request from 'supertest'
import { createApp } from '../../app.js'
import { env } from '../../config/env.js'
import { db } from '../../db/client.js'
import { gates, societies, storedFiles } from '../../db/schema.js'
import { createFlat, createUser, grantPermissions, TEST_SOCIETY_ID, signTestToken } from '../../test/helpers.js'
import { sniff, stripMetadata } from './strip.js'

const OTHER_SOCIETY_ID = '44444444-4444-4444-8444-444444444444'
const app = createApp()

let admin: string
let outsider: string

const tokenFor = (user: { id: string; role: 'ADMIN' | 'RESIDENT' | 'GUARD' }, societyId = TEST_SOCIETY_ID) =>
  signTestToken({ userId: user.id, role: user.role, societyId }).then((token) => `Bearer ${token}`)

/** A JPEG carrying an EXIF segment: two bytes of scan data is all the parser needs to copy. */
function jpeg() {
  const exif = Buffer.from('Exif\0\0location-and-serial-number', 'latin1')
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x00]), exif])
  app1.writeUInt16BE(exif.length + 2, 2)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6])])
}

function chunk(type: string, body: Buffer) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(body.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, body, Buffer.alloc(4)]) // CRC is never read back
}

function png() {
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
    chunk('IHDR', Buffer.alloc(13)),
    chunk('tEXt', Buffer.from('Comment\0taken-at-home', 'latin1')),
    chunk('IDAT', Buffer.from('pixels', 'latin1')),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function webp() {
  const riffChunk = (type: string, body: Buffer) => {
    const header = Buffer.alloc(8)
    header.write(type, 0, 'latin1')
    header.writeUInt32LE(body.length, 4)
    return Buffer.concat([header, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const body = Buffer.concat([riffChunk('VP8 ', Buffer.from('pixels')), riffChunk('EXIF', Buffer.from('gps-fix-here'))])
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(4 + body.length, 4)
  header.write('WEBP', 8, 'latin1')
  return Buffer.concat([header, body])
}

const upload = (bytes: Buffer, type = 'image/jpeg', token = admin) =>
  request(app).post('/api/v1/files').set('Authorization', token).set('Content-Type', type).send(bytes)

beforeEach(async () => {
  const adminUser = await createUser({ phone: '9000000001', email: null, role: 'ADMIN' })
  await grantPermissions(adminUser.id, ['STAFF_MANAGE', 'GUARD_MANAGE', 'SOCIETY_MANAGE'])
  admin = await tokenFor(adminUser)
  await db.insert(societies).values({ id: OTHER_SOCIETY_ID, name: 'Elsewhere' }).onConflictDoNothing()
  const other = await createUser({ phone: '9000000009', email: null, role: 'ADMIN' })
  outsider = await tokenFor(other, OTHER_SOCIETY_ID)
})

describe('metadata', () => {
  it('drops what the camera wrote and keeps the picture, in all three formats', () => {
    const cleanJpeg = stripMetadata(jpeg(), 'image/jpeg')
    expect(cleanJpeg.includes('location-and-serial-number')).toBe(false)
    expect(cleanJpeg.subarray(-6)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]))

    const cleanPng = stripMetadata(png(), 'image/png')
    expect(cleanPng.includes('taken-at-home')).toBe(false)
    expect(cleanPng.includes('pixels')).toBe(true)

    const cleanWebp = stripMetadata(webp(), 'image/webp')
    expect(cleanWebp.includes('gps-fix-here')).toBe(false)
    expect(cleanWebp.includes('pixels')).toBe(true)
    expect(cleanWebp.readUInt32LE(4)).toBe(cleanWebp.length - 8)
  })

  it('reads the real type from the bytes, not from the name', () => {
    expect(sniff(jpeg())).toBe('image/jpeg')
    expect(sniff(png())).toBe('image/png')
    expect(sniff(webp())).toBe('image/webp')
    expect(sniff(Buffer.from('#!/bin/sh\necho hello\n'))).toBeNull()
  })
})

describe('upload', () => {
  it('stores the stripped image under a UUID and hands back a reference', async () => {
    const res = await upload(jpeg())

    expect(res.status).toBe(201)
    expect(res.body.data.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.body.data.contentType).toBe('image/jpeg')

    const [row] = await db.select().from(storedFiles)
    expect(row!.societyId).toBe(TEST_SOCIETY_ID)
    const onDisk = await readFile(join(env.FILE_STORAGE_DIR, `${row!.id}.jpg`))
    expect(onDisk.includes('location-and-serial-number')).toBe(false)
    expect(onDisk.length).toBe(row!.byteSize)
  })

  it('refuses anything that is not a JPEG, PNG or WebP', async () => {
    const renamed = await upload(Buffer.from('#!/bin/sh\necho hello\n'), 'image/png')
    expect(renamed.status).toBe(400)
    expect(renamed.body.error.code).toBe('INVALID_FILE')

    expect((await request(app).post('/api/v1/files').set('Authorization', admin).send({ photo: 'x' })).status).toBe(400)
    expect(await db.select().from(storedFiles)).toHaveLength(0)
  })

  it('serves an image back only to this society, and only with a session', async () => {
    const { body } = await upload(png(), 'image/png')

    const mine = await request(app).get(`/api/v1/files/${body.data.id}`).set('Authorization', admin)
    expect(mine.status).toBe(200)
    expect(mine.headers['content-type']).toContain('image/png')
    expect(mine.headers['cache-control']).toContain('private')

    expect((await request(app).get(`/api/v1/files/${body.data.id}`).set('Authorization', outsider)).status).toBe(404)
    expect((await request(app).get(`/api/v1/files/${body.data.id}`)).status).toBe(401)
  })
})

describe('records that keep a photo', () => {
  it('requires a staff photograph that was really stored', async () => {
    const [gate] = await db.insert(gates).values({ societyId: TEST_SOCIETY_ID, code: 'MAIN', name: 'Main gate' }).returning()
    await createFlat()
    const member = {
      kind: 'GUARD' as const,
      name: 'Mahesh Patil',
      phone: '9811111111',
      gateId: gate!.id,
      shift: 'MORNING' as const,
    }
    const register = (body: object) =>
      request(app).post(`/api/v1/societies/${TEST_SOCIETY_ID}/staff`).set('Authorization', admin).send(body)

    expect((await register(member)).status).toBe(422)
    expect((await register({ ...member, photoReference: '99999999-9999-4999-8999-999999999999' })).status).toBe(404)

    const { body } = await upload(jpeg())
    const created = await register({ ...member, photoReference: body.data.id })
    expect(created.status).toBe(201)
    expect(created.body.data.photoReference).toBe(body.data.id)
  })
})
