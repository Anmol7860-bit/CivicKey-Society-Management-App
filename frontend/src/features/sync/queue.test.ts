import { IDBFactory } from 'fake-indexeddb'
import { cacheGet, cachePut, CACHE_MAX_AGE_MS } from './cache'
import { closeDbForTests } from './db'
import { enqueue, MAX_RETRIES, readMetadata, readQueue, syncNow } from './queue'

const fetchMock = vi.fn()

function reply(status: number, body: unknown = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }))
}

beforeEach(() => {
  closeDbForTests()
  globalThis.indexedDB = new IDBFactory()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('sync queue', () => {
  it('keeps an entry recorded offline on the device until it syncs', async () => {
    const record = await enqueue('VISITOR_REGISTER', { name: 'Ravi', flat: 'A-101' })

    expect(record).toMatchObject({ status: 'PENDING_SYNC', retryCount: 0, lastErrorCode: null, entityId: null })
    expect(await readQueue()).toEqual([record])
    expect(await readMetadata()).toMatchObject({ pendingCount: 1, lastSyncedAt: null })
  })

  it('uploads waiting entries oldest first with their client event id, then marks them synced', async () => {
    const first = await enqueue('VISITOR_REGISTER', { name: 'Ravi' })
    const second = await enqueue('VISIT_EXIT', {}, 'visit-1')
    fetchMock.mockImplementation(() => reply(201))

    const meta = await syncNow('token-1')

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))
    expect(bodies.map((body) => body.clientEventId)).toEqual([first.clientEventId, second.clientEventId])
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token-1')
    expect((await readQueue()).map((record) => record.status)).toEqual(['SYNCED', 'SYNCED'])
    expect(meta).toMatchObject({ status: 'IDLE', pendingCount: 0, lastError: null })
    expect(meta.lastSyncedAt).not.toBeNull()
  })

  it('stops when the backend is unreachable and keeps every entry for retry', async () => {
    await enqueue('VISITOR_REGISTER', { name: 'Ravi' })
    await enqueue('VISITOR_REGISTER', { name: 'Asha' })
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const meta = await syncNow('token')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [first, second] = await readQueue()
    expect(first).toMatchObject({ status: 'FAILED_RETRY', retryCount: 1, lastErrorCode: 'NETWORK_ERROR' })
    expect(second).toMatchObject({ status: 'PENDING_SYNC', retryCount: 0 })
    expect(meta).toMatchObject({ status: 'ERROR', lastError: 'NETWORK_ERROR', pendingCount: 2, lastSyncedAt: null })

    // Backend back: the retry uploads both
    fetchMock.mockImplementation(() => reply(200))
    expect(await syncNow('token')).toMatchObject({ status: 'IDLE', pendingCount: 0 })
  })

  it('sets aside an entry the backend refuses and carries on with the rest', async () => {
    await enqueue('VISITOR_REGISTER', { name: '' })
    await enqueue('VISITOR_REGISTER', { name: 'Asha' })
    fetchMock.mockReturnValueOnce(reply(400, { error: { code: 'VALIDATION_ERROR' } })).mockReturnValueOnce(reply(201))

    const meta = await syncNow('token')

    expect((await readQueue()).map((record) => [record.status, record.lastErrorCode])).toEqual([
      ['FAILED_ADMIN', 'VALIDATION_ERROR'],
      ['SYNCED', null],
    ])
    expect(meta).toMatchObject({ status: 'ERROR', lastError: 'VALIDATION_ERROR', pendingCount: 0 })
  })

  it('retries a server error, then hands it to an admin after the last attempt', async () => {
    await enqueue('VISIT_ENTRY_RECORD', {}, 'visit-1')
    fetchMock.mockImplementation(() => reply(503, { error: { code: 'SERVICE_UNAVAILABLE' } }))

    for (let attempt = 1; attempt < MAX_RETRIES; attempt++) await syncNow('token')
    expect((await readQueue())[0]).toMatchObject({ status: 'FAILED_RETRY', retryCount: MAX_RETRIES - 1 })

    await syncNow('token')
    expect((await readQueue())[0]).toMatchObject({ status: 'FAILED_ADMIN', retryCount: MAX_RETRIES })
  })

  it('shares one run between concurrent sync calls', async () => {
    await enqueue('VISITOR_REGISTER', {})
    fetchMock.mockImplementation(() => reply(201))

    await Promise.all([syncNow('token'), syncNow('token')])

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('offline cache', () => {
  it('serves reference data until it expires, then discards it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await cachePut('visitorPasses', [{ code: '482913' }])

    expect((await cacheGet('visitorPasses'))?.data).toEqual([{ code: '482913' }])

    vi.advanceTimersByTime(CACHE_MAX_AGE_MS.visitorPasses + 1)
    expect(await cacheGet('visitorPasses')).toBeNull()
  })
})
