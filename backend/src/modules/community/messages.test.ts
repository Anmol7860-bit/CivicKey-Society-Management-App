import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { auditLogs, communityGroups, communityMessages, flats } from '../../db/schema.js'
import { addResident, createFlat, createUser, grantPermissions, signTestToken, TEST_SOCIETY_ID } from '../../test/helpers.js'
import { audience } from './community.service.js'

const app = createApp()

let auth: string
let adminId: string
let riya: { id: string; token: string }
let amit: { id: string; token: string }
let blockId: string

const api = {
  get: (path: string, token = auth) => request(app).get(`/api/v1${path}`).set('Authorization', token),
  post: (path: string, body: object = {}, token = auth) => request(app).post(`/api/v1${path}`).set('Authorization', token).send(body),
  delete: (path: string, token = auth) => request(app).delete(`/api/v1${path}`).set('Authorization', token),
}

const groups = `/societies/${TEST_SOCIETY_ID}/groups`

async function group(body: object = { name: 'Sports' }) {
  const res = await api.post(groups, body)
  expect(res.status).toBe(201)
  return res.body.data
}

async function resident(phone: string, flatId: string) {
  const user = await createUser({ phone, email: null })
  await addResident(flatId, user.id)
  return { id: user.id, token: `Bearer ${await signTestToken({ userId: user.id, role: 'RESIDENT', societyId: TEST_SOCIETY_ID })}` }
}

beforeEach(async () => {
  const flat = await createFlat()
  blockId = flat.blockId
  const [second] = await db.insert(flats).values({ blockId: flat.blockId, floorId: flat.floorId, number: '102' }).returning()

  const admin = await createUser({ phone: '9000000001', email: null, role: 'ADMIN' })
  adminId = admin.id
  await grantPermissions(admin.id, ['GROUP_MANAGE'])
  auth = `Bearer ${await signTestToken({ userId: admin.id, role: 'ADMIN', societyId: TEST_SOCIETY_ID })}`
  riya = await resident('9000000002', flat.id)
  amit = await resident('9000000003', second!.id)
})

describe('posting and reading', () => {
  it('carries the author and comes back newest first', async () => {
    const sports = await group()
    await api.post(`/groups/${sports.id}/members`, { userId: riya.id })

    expect((await api.post(`/groups/${sports.id}/messages`, { body: 'Nets at 7' }, riya.token)).body.data).toMatchObject({
      authorId: riya.id,
      authorName: 'Riya Sharma',
      body: 'Nets at 7',
      removed: false,
    })
    await api.post(`/groups/${sports.id}/messages`, { body: 'I will bring the stumps' })

    const messages = (await api.get(`/groups/${sports.id}/messages`, riya.token)).body.data
    expect(messages.map((message: { body: string }) => message.body)).toEqual(['I will bring the stumps', 'Nets at 7'])
  })

  it('refuses an empty message and an archived group', async () => {
    const sports = await group()
    expect((await api.post(`/groups/${sports.id}/messages`, { body: '   ' })).status).toBe(422)

    await api.post(`/groups/${sports.id}/archive`, { reason: 'The season is over' })
    expect((await api.post(`/groups/${sports.id}/messages`, { body: 'Anyone there?' })).body.error.code).toBe('INVALID_STATE')
    // The conversation is still readable once the group is closed
    expect((await api.get(`/groups/${sports.id}/messages`)).status).toBe(200)
  })

  it('keeps a resident out of a group they are not in', async () => {
    const sports = await group()
    await api.post(`/groups/${sports.id}/members`, { userId: riya.id })

    expect((await api.get(`/groups/${sports.id}/messages`, amit.token)).body.error.code).toBe('PERMISSION_DENIED')
    expect((await api.post(`/groups/${sports.id}/messages`, { body: 'Hello?' }, amit.token)).body.error.code).toBe('PERMISSION_DENIED')
  })

  it('opens a block group to everyone the register puts in it', async () => {
    const block = await group({ name: 'Block A', scope: 'BLOCK', blockId })

    expect((await api.post(`/groups/${block.id}/messages`, { body: 'Water tanker at 9' }, amit.token)).status).toBe(201)
    expect((await api.get(`/groups/${block.id}/messages`, riya.token)).body.data).toHaveLength(1)
  })

  it('walks back through the conversation with before', async () => {
    const sports = await group()
    const first = (await api.post(`/groups/${sports.id}/messages`, { body: 'First' })).body.data
    await api.post(`/groups/${sports.id}/messages`, { body: 'Second' })

    const page = (await api.get(`/groups/${sports.id}/messages?limit=1`)).body.data
    expect(page).toHaveLength(1)
    expect(page[0].body).toBe('Second')
    const older = (await api.get(`/groups/${sports.id}/messages?before=${encodeURIComponent(page[0].createdAt)}`)).body.data
    expect(older.map((message: { id: string }) => message.id)).toEqual([first.id])
  })
})

describe('removing a message', () => {
  it('lets the author take their own back, keeping its place', async () => {
    const sports = await group()
    await api.post(`/groups/${sports.id}/members`, { userId: riya.id })
    const message = (await api.post(`/groups/${sports.id}/messages`, { body: 'Wrong group, sorry' }, riya.token)).body.data

    expect((await api.delete(`/messages/${message.id}`, riya.token)).status).toBe(200)
    expect((await api.get(`/groups/${sports.id}/messages`, riya.token)).body.data[0]).toMatchObject({ body: null, removed: true })
    expect((await api.delete(`/messages/${message.id}`, riya.token)).body.error.code).toBe('INVALID_STATE')

    const [row] = await db.select().from(communityMessages).where(eq(communityMessages.id, message.id))
    expect(row!.deletedBy).toBe(riya.id)
  })

  it('lets the office remove anyone, and nobody else', async () => {
    const sports = await group()
    await api.post(`/groups/${sports.id}/members`, { userId: riya.id })
    await api.post(`/groups/${sports.id}/members`, { userId: amit.id })
    const message = (await api.post(`/groups/${sports.id}/messages`, { body: 'Out of order' }, riya.token)).body.data

    expect((await api.delete(`/messages/${message.id}`, amit.token)).body.error.code).toBe('PERMISSION_DENIED')
    expect((await api.delete(`/messages/${message.id}`)).status).toBe(200)

    const [entry] = await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'COMMUNITY_MESSAGE_REMOVED'))
    expect(entry!.actorUserId).toBe(adminId)
    expect(entry!.metadata).toMatchObject({ messageId: message.id, authorId: riya.id, byTheOffice: true })
  })
})

describe('who hears a message', () => {
  it('is the block for a block group, and the picked for a hand-picked one', async () => {
    const block = await group({ name: 'Block A', scope: 'BLOCK', blockId })
    const sports = await group()
    await api.post(`/groups/${sports.id}/members`, { userId: riya.id })

    const [blockRow] = await db.select().from(communityGroups).where(eq(communityGroups.id, block.id))
    const [sportsRow] = await db.select().from(communityGroups).where(eq(communityGroups.id, sports.id))

    // The office hears both, so it can answer from the admin side
    expect((await audience(blockRow!)).sort()).toEqual([adminId, riya.id, amit.id].sort())
    expect((await audience(sportsRow!)).sort()).toEqual([adminId, riya.id].sort())
  })
})
