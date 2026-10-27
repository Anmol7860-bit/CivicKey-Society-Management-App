import request from 'supertest'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { auditLogs, staff } from '../../db/schema.js'
import { createFlat, createUser, grantPermissions, TEST_SOCIETY_ID, signTestToken } from '../../test/helpers.js'

const OTHER_SOCIETY_ID = '33333333-3333-4333-8333-333333333333'
const MISSING_ID = '44444444-4444-4444-8444-444444444444'
const app = createApp()

let auth: string
let staffId: string

const api = {
  get: (path: string, token = auth) => request(app).get(`/api/v1${path}`).set('Authorization', token),
  post: (path: string, body: object = {}, token = auth) => request(app).post(`/api/v1${path}`).set('Authorization', token).send(body),
  put: (path: string, body: object, token = auth) => request(app).put(`/api/v1${path}`).set('Authorization', token).send(body),
}

const tasks = `/societies/${TEST_SOCIETY_ID}/tasks`
const aTask = { title: 'Lobby light is out', category: 'ELECTRICAL' as const, location: 'B wing lobby' }

async function create(body: object = aTask) {
  const res = await api.post(tasks, body)
  expect(res.status).toBe(201)
  return res.body.data
}

beforeEach(async () => {
  await createFlat()
  await createFlat(OTHER_SOCIETY_ID, '501')
  const admin = await createUser({ phone: '9000000001', email: null, role: 'ADMIN' })
  await grantPermissions(admin.id, ['SOCIETY_MANAGE'])
  auth = `Bearer ${await signTestToken({ userId: admin.id, role: 'ADMIN', societyId: TEST_SOCIETY_ID })}`
  const [member] = await db
    .insert(staff)
    .values({ societyId: TEST_SOCIETY_ID, kind: 'VENDOR', name: 'Mahesh the plumber', phone: '9870000001', workType: 'Plumbing', passCode: 'CK-TESTVEND1' })
    .returning()
  staffId = member!.id
})

describe('authorization', () => {
  it('needs a token and SOCIETY_MANAGE', async () => {
    const resident = await createUser({ phone: '9000000002', email: null })

    expect((await request(app).get(`/api/v1${tasks}`)).status).toBe(401)
    const token = `Bearer ${await signTestToken({ userId: resident.id, role: 'RESIDENT', societyId: TEST_SOCIETY_ID })}`
    expect((await api.get(tasks, token)).body.error.code).toBe('PERMISSION_DENIED')
  })

  it('refuses another society and unknown ids', async () => {
    expect((await api.get(`/societies/${OTHER_SOCIETY_ID}/tasks`)).body.error.code).toBe('CROSS_SOCIETY_ACCESS')
    expect((await api.post(`/tasks/${MISSING_ID}/status`, { status: 'DONE' })).status).toBe(404)
  })
})

describe('raising a task', () => {
  it('records who raised it and starts it open', async () => {
    const task = await create()

    expect(task).toMatchObject({
      title: 'Lobby light is out',
      category: 'ELECTRICAL',
      priority: 'NORMAL',
      status: 'OPEN',
      location: 'B wing lobby',
      assignee: null,
      closedAt: null,
      overdue: false,
    })
    expect(task.raisedByName).toBe('Riya Sharma')
  })

  it('hands it to staff of this society only', async () => {
    const task = await create({ ...aTask, assignedStaffId: staffId })
    expect(task.assignee).toMatchObject({ id: staffId, name: 'Mahesh the plumber', workType: 'Plumbing' })

    const [outsider] = await db
      .insert(staff)
      .values({ societyId: OTHER_SOCIETY_ID, kind: 'VENDOR', name: 'Someone else', phone: '9870000002', passCode: 'CK-TESTVEND2' })
      .returning()
    const res = await api.post(tasks, { ...aTask, assignedStaffId: outsider!.id })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_STATE')
  })

  it('insists on a title and refuses unknown fields', async () => {
    expect((await api.post(tasks, { title: 'no' })).status).toBe(422)
    expect((await api.post(tasks, { ...aTask, assignedTo: 'someone' })).status).toBe(422)
  })
})

describe('moving a task along', () => {
  it('closes with when and why, and will not close twice', async () => {
    const task = await create()

    const started = await api.post(`/tasks/${task.id}/status`, { status: 'IN_PROGRESS' })
    expect(started.body.data.status).toBe('IN_PROGRESS')
    expect(started.body.data.closedAt).toBeNull()

    const done = await api.post(`/tasks/${task.id}/status`, { status: 'DONE', note: 'New tube fitted' })
    expect(done.body.data).toMatchObject({ status: 'DONE', closingNote: 'New tube fitted' })
    expect(done.body.data.closedAt).not.toBeNull()

    expect((await api.post(`/tasks/${task.id}/status`, { status: 'DONE' })).status).toBe(400)
  })

  it('clears the closing note when a finished task is reopened', async () => {
    const task = await create()
    await api.post(`/tasks/${task.id}/status`, { status: 'DONE', note: 'Done' })

    const reopened = await api.post(`/tasks/${task.id}/status`, { status: 'OPEN' })
    expect(reopened.body.data).toMatchObject({ status: 'OPEN', closedAt: null, closingNote: null })
  })

  it('wants a reason to cancel, and will not move a cancelled task', async () => {
    const task = await create()

    expect((await api.post(`/tasks/${task.id}/status`, { status: 'CANCELLED' })).status).toBe(422)
    const cancelled = await api.post(`/tasks/${task.id}/status`, { status: 'CANCELLED', note: 'Raised twice' })
    expect(cancelled.body.data.status).toBe('CANCELLED')
    expect((await api.post(`/tasks/${task.id}/status`, { status: 'OPEN' })).status).toBe(400)
  })

  it('refuses to edit a closed task', async () => {
    const task = await create()
    await api.post(`/tasks/${task.id}/status`, { status: 'DONE', note: 'Done' })

    expect((await api.put(`/tasks/${task.id}`, { priority: 'HIGH' })).status).toBe(400)
  })
})

describe('the work list', () => {
  it('puts open and pressing work first', async () => {
    await create({ ...aTask, title: 'Low and open', priority: 'LOW' })
    const done = await create({ ...aTask, title: 'Already finished' })
    await api.post(`/tasks/${done.id}/status`, { status: 'DONE', note: 'Done' })
    await create({ ...aTask, title: 'Urgent leak', priority: 'HIGH' })

    const list = (await api.get(tasks)).body.data
    expect(list.map((task: { title: string }) => task.title)).toEqual(['Urgent leak', 'Low and open', 'Already finished'])
  })

  it('filters by status, category, assignee, overdue and free text', async () => {
    const assigned = await create({ ...aTask, assignedStaffId: staffId })
    await create({ title: 'Sweep the stairwell', category: 'HOUSEKEEPING' })
    const late = await create({ title: 'Lift inspection due', category: 'LIFT', dueDate: '2020-01-01' })

    const only = async (query: string) => (await api.get(`${tasks}?${query}`)).body.data.map((task: { id: string }) => task.id)

    expect(await only(`assignedStaffId=${staffId}`)).toEqual([assigned.id])
    expect(await only('category=HOUSEKEEPING')).toHaveLength(1)
    expect(await only('overdue=true')).toEqual([late.id])
    expect(await only('search=stairwell')).toHaveLength(1)
    expect(await only('status=DONE')).toEqual([])
  })

  it('marks an open task past its due date as overdue', async () => {
    const late = await create({ ...aTask, dueDate: '2020-01-01' })
    const [row] = (await api.get(tasks)).body.data

    expect(row.id).toBe(late.id)
    expect(row.overdue).toBe(true)
  })

  it('counts the summary over every task, not just the page', async () => {
    const first = await create({ ...aTask, dueDate: '2020-01-01' })
    await create({ ...aTask, title: 'Unassigned work' })
    const finished = await create({ ...aTask, title: 'Finished' })
    await api.post(`/tasks/${finished.id}/status`, { status: 'DONE', note: 'Done' })
    await api.post(`/tasks/${first.id}/status`, { status: 'IN_PROGRESS' })

    const summary = (await api.get(`/societies/${TEST_SOCIETY_ID}/task-summary`)).body.data
    expect(summary).toEqual({ open: 1, inProgress: 1, overdue: 1, unassigned: 2, doneThisMonth: 1 })
  })
})

it('leaves an audit trail for every change', async () => {
  const task = await create()
  await api.put(`/tasks/${task.id}`, { priority: 'HIGH', assignedStaffId: staffId })
  await api.post(`/tasks/${task.id}/status`, { status: 'DONE', note: 'Fixed' })

  const events = await db.select().from(auditLogs)
  expect(events.map((event) => event.eventType)).toEqual(['TASK_CREATED', 'TASK_UPDATED', 'TASK_STATUS_CHANGED'])
  expect(events[2]!.metadata).toMatchObject({ from: 'OPEN', to: 'DONE', note: 'Fixed' })
})
