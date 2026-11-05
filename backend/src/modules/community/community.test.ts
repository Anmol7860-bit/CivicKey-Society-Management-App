import request from 'supertest'
import { and, eq } from 'drizzle-orm'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { auditLogs, communityGroupMembers, flats } from '../../db/schema.js'
import { addResident, createFlat, createUser, grantPermissions, signTestToken, TEST_SOCIETY_ID } from '../../test/helpers.js'

const OTHER_SOCIETY_ID = '33333333-3333-4333-8333-333333333333'
const MISSING_ID = '44444444-4444-4444-8444-444444444444'
const app = createApp()

let auth: string
let riya: { id: string; token: string }
let amit: { id: string; token: string }
let blockId: string

const api = {
  get: (path: string, token = auth) => request(app).get(`/api/v1${path}`).set('Authorization', token),
  post: (path: string, body: object = {}, token = auth) => request(app).post(`/api/v1${path}`).set('Authorization', token).send(body),
  delete: (path: string, token = auth) => request(app).delete(`/api/v1${path}`).set('Authorization', token),
}

const groups = `/societies/${TEST_SOCIETY_ID}/groups`

async function create(body: object = { name: 'Sports' }) {
  const res = await api.post(groups, body)
  expect(res.status).toBe(201)
  return res.body.data
}

async function resident(phone: string, flatId: string, residentType: 'OWNER' | 'TENANT' = 'OWNER') {
  const user = await createUser({ phone, email: null })
  await addResident(flatId, user.id, { residentType })
  return { id: user.id, token: `Bearer ${await signTestToken({ userId: user.id, role: 'RESIDENT', societyId: TEST_SOCIETY_ID })}` }
}

beforeEach(async () => {
  // Two flats in one block, so a block group has a register to derive its members from
  const flat = await createFlat()
  blockId = flat.blockId
  const [second] = await db.insert(flats).values({ blockId: flat.blockId, floorId: flat.floorId, number: '102' }).returning()
  await createFlat(OTHER_SOCIETY_ID, '501')

  const admin = await createUser({ phone: '9000000001', email: null, role: 'ADMIN' })
  await grantPermissions(admin.id, ['GROUP_MANAGE'])
  auth = `Bearer ${await signTestToken({ userId: admin.id, role: 'ADMIN', societyId: TEST_SOCIETY_ID })}`
  riya = await resident('9000000002', flat.id)
  amit = await resident('9000000003', second!.id)
})

describe('authorization', () => {
  it('takes GROUP_MANAGE or COMMUNITY_POST, and nothing else', async () => {
    const guard = await createUser({ phone: '9000000004', email: null, role: 'GUARD' })
    const guardToken = `Bearer ${await signTestToken({ userId: guard.id, role: 'GUARD', societyId: TEST_SOCIETY_ID })}`

    expect((await request(app).get(`/api/v1${groups}`)).status).toBe(401)
    expect((await api.get(groups, guardToken)).body.error.code).toBe('PERMISSION_DENIED')
    expect((await api.get(groups, riya.token)).status).toBe(200)
  })

  it('refuses another society and unknown ids', async () => {
    expect((await api.get(`/societies/${OTHER_SOCIETY_ID}/groups`)).body.error.code).toBe('CROSS_SOCIETY_ACCESS')
    expect((await api.get(`/groups/${MISSING_ID}/members`)).status).toBe(404)
  })

  it('keeps group creation to the office', async () => {
    expect((await api.post(groups, { name: 'Sports' }, riya.token)).body.error.code).toBe('PERMISSION_DENIED')
  })
})

describe('creating a group', () => {
  it('records who created it and audits it', async () => {
    const group = await create({ name: 'Sports', purpose: 'Saturday cricket' })

    expect(group).toMatchObject({ name: 'Sports', scope: 'CUSTOM', blockId: null, archivedAt: null })
    const [entry] = await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'GROUP_CREATED'))
    expect(entry!.metadata).toMatchObject({ groupId: group.id, scope: 'CUSTOM' })
  })

  it('ties a block to the block scope', async () => {
    expect((await api.post(groups, { name: 'Block A', scope: 'BLOCK' })).status).toBe(422)
    expect((await api.post(groups, { name: 'Sports', scope: 'CUSTOM', blockId })).status).toBe(422)
    expect((await api.post(groups, { name: 'Block A', scope: 'BLOCK', blockId })).status).toBe(201)
  })

  it('allows one group per name, one per block and one for the society', async () => {
    await create()
    expect((await api.post(groups, { name: 'sports' })).body.error.code).toBe('ALREADY_EXISTS')

    expect((await api.post(groups, { name: 'Everyone', scope: 'SOCIETY' })).status).toBe(201)
    expect((await api.post(groups, { name: 'Everyone again', scope: 'SOCIETY' })).body.error.code).toBe('ALREADY_EXISTS')
  })
})

describe('listing groups', () => {
  it('counts a derived group from the register and a hand-picked one from its rows', async () => {
    await create({ name: 'Everyone', scope: 'SOCIETY' })
    await create({ name: 'Block A', scope: 'BLOCK', blockId })
    const sports = await create()
    await api.post(`/groups/${sports.id}/members`, { userId: riya.id })

    const byName = Object.fromEntries((await api.get(groups)).body.data.map((group: { name: string }) => [group.name, group]))
    expect(byName.Everyone).toMatchObject({ derived: true, members: 2 })
    expect(byName['Block A']).toMatchObject({ derived: true, members: 2 })
    expect(byName.Sports).toMatchObject({ derived: false, members: 1 })
  })

  it('shows a resident only the groups they are in', async () => {
    await create({ name: 'Everyone', scope: 'SOCIETY' })
    const sports = await create()
    await api.post(`/groups/${sports.id}/members`, { userId: riya.id })

    const mine = (await api.get(groups, riya.token)).body.data
    expect(mine.map((group: { name: string }) => group.name).sort()).toEqual(['Everyone', 'Sports'])
    expect(mine.find((group: { name: string }) => group.name === 'Everyone')).toMatchObject({ myRole: 'MEMBER' })

    const theirs = (await api.get(groups, amit.token)).body.data
    expect(theirs.map((group: { name: string }) => group.name)).toEqual(['Everyone'])
  })

  it('leaves archived groups out unless they are asked for', async () => {
    const sports = await create()
    expect((await api.post(`/groups/${sports.id}/archive`, { reason: 'The season is over' })).status).toBe(200)

    expect((await api.get(groups)).body.data).toHaveLength(0)
    expect((await api.get(`${groups}?archived=true`)).body.data).toHaveLength(1)
  })
})

describe('membership', () => {
  it('adds a resident, and refuses anyone the register does not know', async () => {
    const sports = await create()
    const guard = await createUser({ phone: '9000000005', email: null, role: 'GUARD' })

    expect((await api.post(`/groups/${sports.id}/members`, { userId: riya.id })).status).toBe(201)
    expect((await api.post(`/groups/${sports.id}/members`, { userId: riya.id })).body.error.code).toBe('ALREADY_EXISTS')
    expect((await api.post(`/groups/${sports.id}/members`, { userId: guard.id })).body.error.code).toBe('ASSIGNEE_NOT_ELIGIBLE')
  })

  it('appoints a leader on a derived group but takes no members for it', async () => {
    const block = await create({ name: 'Block A', scope: 'BLOCK', blockId })

    expect((await api.post(`/groups/${block.id}/members`, { userId: riya.id })).body.error.code).toBe('INVALID_STATE')
    expect((await api.post(`/groups/${block.id}/members`, { userId: riya.id, role: 'LEADER' })).status).toBe(201)

    const members = (await api.get(`/groups/${block.id}/members`)).body.data
    expect(members).toHaveLength(2)
    expect(members.find((member: { userId: string }) => member.userId === riya.id)).toMatchObject({ role: 'LEADER', derived: false })
    expect(members.find((member: { userId: string }) => member.userId === amit.id)).toMatchObject({ role: 'MEMBER', derived: true })
  })

  it('lets a leader fill their own group, but never appoint another leader', async () => {
    const sports = await create()
    await api.post(`/groups/${sports.id}/members`, { userId: riya.id, role: 'LEADER' })

    expect((await api.post(`/groups/${sports.id}/members`, { userId: amit.id }, riya.token)).status).toBe(201)
    expect((await api.post(`/groups/${sports.id}/members`, { userId: amit.id, role: 'LEADER' }, riya.token)).body.error.code).toBe('PERMISSION_DENIED')
  })

  it('keeps a resident who is in no group out of its membership', async () => {
    const sports = await create()
    await api.post(`/groups/${sports.id}/members`, { userId: riya.id })

    expect((await api.get(`/groups/${sports.id}/members`, amit.token)).body.error.code).toBe('PERMISSION_DENIED')
    expect((await api.post(`/groups/${sports.id}/members`, { userId: amit.id }, amit.token)).body.error.code).toBe('PERMISSION_DENIED')
    expect((await api.get(`/groups/${sports.id}/members`, riya.token)).status).toBe(200)
  })

  it('removes a member by keeping the row, and keeps a leader for the office', async () => {
    const sports = await create()
    await api.post(`/groups/${sports.id}/members`, { userId: riya.id, role: 'LEADER' })
    await api.post(`/groups/${sports.id}/members`, { userId: amit.id })

    expect((await api.delete(`/groups/${sports.id}/members/${riya.id}`, amit.token)).body.error.code).toBe('PERMISSION_DENIED')
    expect((await api.delete(`/groups/${sports.id}/members/${amit.id}`, riya.token)).status).toBe(200)
    expect((await api.delete(`/groups/${sports.id}/members/${amit.id}`)).status).toBe(404)

    const [row] = await db
      .select()
      .from(communityGroupMembers)
      .where(and(eq(communityGroupMembers.groupId, sports.id), eq(communityGroupMembers.userId, amit.id)))
    expect(row!.removedAt).not.toBeNull()
    const [entry] = await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'GROUP_MEMBER_REMOVED'))
    expect(entry!.metadata).toMatchObject({ groupId: sports.id, userId: amit.id, role: 'MEMBER' })
  })
})

describe('archiving', () => {
  it('needs a reason, happens once, and closes the group to new members', async () => {
    const sports = await create()

    expect((await api.post(`/groups/${sports.id}/archive`)).status).toBe(422)
    expect((await api.post(`/groups/${sports.id}/archive`, { reason: 'The season is over' })).body.data.archivedAt).not.toBeNull()
    expect((await api.post(`/groups/${sports.id}/archive`, { reason: 'Again' })).body.error.code).toBe('INVALID_STATE')
    expect((await api.post(`/groups/${sports.id}/members`, { userId: riya.id })).body.error.code).toBe('INVALID_STATE')

    const [entry] = await db.select().from(auditLogs).where(eq(auditLogs.eventType, 'GROUP_ARCHIVED'))
    expect(entry!.metadata).toMatchObject({ groupId: sports.id, reason: 'The season is over' })
  })
})
