import { createApp } from '../app.js'
import { db } from '../db/client.js'
import { PASSWORD, createUser, postLogin, postRefresh, type App } from '../test/helpers.js'

const internalError = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } }

describe('unexpected failures', () => {
  let app: App

  beforeEach(() => {
    app = createApp()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a generic 500 with a request id when the database is unavailable', async () => {
    vi.spyOn(db, 'select').mockImplementation(() => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })
    })

    const res = await postLogin(app, { phone: '9876543210', password: PASSWORD })

    expect(res.status).toBe(500)
    expect(res.body).toEqual(internalError)
    expect(res.headers['x-request-id']).toBeTruthy()
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|5432|stack/)
  })

  it('returns a generic 500 without a stack trace when the auth service throws', async () => {
    vi.spyOn(db, 'transaction').mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'id')"))

    const res = await postRefresh(app, 'some-refresh-token')

    expect(res.status).toBe(500)
    expect(res.body).toEqual(internalError)
    expect(res.headers['x-request-id']).toBeTruthy()
  })

  it('keeps serving requests after a failure', async () => {
    vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('connection terminated')
    })
    await createUser()

    expect((await postLogin(app, { phone: '9876543210', password: PASSWORD })).status).toBe(500)
    expect((await postLogin(app, { phone: '9876543210', password: PASSWORD })).status).toBe(200)
  })
})
