import { IDBFactory } from 'fake-indexeddb'
import { cacheGet, cachePut, CACHE_MAX_AGE_MS } from './cache'
import { closeDbForTests } from './db'
import { enqueue, MAX_BATCH, MAX_RETRIES, readMetadata, readQueue, syncNow, type EventResultStatus } from './queue'

const fetchMock = vi.fn()

function reply(status: number, body: unknown = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }))
}

/** The server's answer: one result per event, as the batch endpoint returns it. */
function results(...answers: [string, EventResultStatus, string | null][]) {
  return reply(200, {
    data: { batchId: 'b1', results: answers.map(([clientEventId, status, code]) => ({ clientEventId, status, entityId: null, code })) },
  })
}

/** Every event in the posted batch, in the order the device sent it. */
const posted = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string).events)

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

    expect(record).toMatchObject({ status: 'PENDING_SYNC', retryCount: 0, lastErrorCode: null, entityId: null, sequence: 1 })
    expect(await readQueue()).toEqual([record])
    expect(await readMetadata()).toMatchObject({ pendingCount: 1, lastSyncedAt: null })
  })

  it('uploads one batch in recorded order and marks each entry from its own result', async () => {
    const first = await enqueue('VISITOR_REGISTER', { name: 'Ravi' })
    const second = await enqueue('VISIT_EXIT', {}, 'visit-1')
    fetchMock.mockImplementation(() => results([first.clientEventId, 'APPLIED', null], [second.clientEventId, 'APPLIED', null]))

    const meta = await syncNow('token-1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(posted()[0].map((event: { clientEventId: string }) => event.clientEventId)).toEqual([first.clientEventId, second.clientEventId])
    expect(posted()[0][0]).toMatchObject({ eventType: 'VISITOR_REGISTER', sequence: 1, localAttemptCount: 0 })
    expect(posted()[0][0].deviceId).toEqual(expect.any(String))
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token-1')
    expect((await readQueue()).map((record) => record.status)).toEqual(['SYNCED', 'SYNCED'])
    expect(meta).toMatchObject({ status: 'IDLE', pendingCount: 0, lastError: null })
    expect(meta.lastSyncedAt).not.toBeNull()
  })

  it('treats a replayed entry the server already has as done', async () => {
    const record = await enqueue('VISITOR_REGISTER', { name: 'Ravi' })
    fetchMock.mockImplementation(() => results([record.clientEventId, 'DUPLICATE_IGNORED', null]))

    expect(await syncNow('token')).toMatchObject({ status: 'IDLE', pendingCount: 0 })
    expect((await readQueue())[0]).toMatchObject({ status: 'SYNCED' })
  })

  it('splits more than one batch worth of entries across posts', async () => {
    for (let n = 0; n < MAX_BATCH + 2; n++) await enqueue('VISITOR_REGISTER', { n })
    fetchMock.mockImplementation((_url: string, init: { body: string }) =>
      results(...JSON.parse(init.body).events.map((e: { clientEventId: string }) => [e.clientEventId, 'APPLIED', null] as [string, EventResultStatus, null])),
    )

    await syncNow('token')

    expect(posted().map((events: unknown[]) => events.length)).toEqual([MAX_BATCH, 2])
  })

  it('keeps every entry for retry when the backend is unreachable', async () => {
    await enqueue('VISITOR_REGISTER', { name: 'Ravi' })
    await enqueue('VISITOR_REGISTER', { name: 'Asha' })
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const meta = await syncNow('token')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    for (const record of await readQueue()) {
      expect(record).toMatchObject({ status: 'FAILED_RETRY', retryCount: 1, lastErrorCode: 'NETWORK_ERROR' })
    }
    expect(meta).toMatchObject({ status: 'ERROR', lastError: 'NETWORK_ERROR', pendingCount: 2, lastSyncedAt: null })

    // Backend back: the retry uploads both
    fetchMock.mockImplementation((_url: string, init: { body: string }) =>
      results(...JSON.parse(init.body).events.map((e: { clientEventId: string }) => [e.clientEventId, 'APPLIED', null] as [string, EventResultStatus, null])),
    )
    expect(await syncNow('token')).toMatchObject({ status: 'IDLE', pendingCount: 0 })
  })

  it('sets aside the entry the backend refused and keeps the rest of the batch', async () => {
    const bad = await enqueue('VISITOR_REGISTER', { name: '' })
    const good = await enqueue('VISITOR_REGISTER', { name: 'Asha' })
    fetchMock.mockImplementation(() => results([bad.clientEventId, 'REJECTED', 'VALIDATION_ERROR'], [good.clientEventId, 'APPLIED', null]))

    const meta = await syncNow('token')

    expect((await readQueue()).map((record) => [record.status, record.lastErrorCode])).toEqual([
      ['FAILED_ADMIN', 'VALIDATION_ERROR'],
      ['SYNCED', null],
    ])
    expect(meta).toMatchObject({ status: 'ERROR', lastError: 'VALIDATION_ERROR', pendingCount: 0 })
  })

  it('holds an entry the server sent for review and stops retrying it', async () => {
    const record = await enqueue('VISITOR_REGISTER', { name: 'Ravi' })
    fetchMock.mockImplementation(() => results([record.clientEventId, 'NEEDS_REVIEW', 'CLOCK_SKEW']))

    await syncNow('token')

    expect((await readQueue())[0]).toMatchObject({ status: 'NEEDS_REVIEW', lastErrorCode: 'CLOCK_SKEW' })
    // It is no longer waiting, so a later sync leaves it alone
    fetchMock.mockClear()
    await syncNow('token')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('counts a retryable result and keeps the entry queued', async () => {
    const record = await enqueue('VISIT_ENTRY_RECORD', {}, 'visit-1')
    fetchMock.mockImplementation(() => results([record.clientEventId, 'FAILED_RETRY', 'SYNC_IN_PROGRESS']))

    for (let attempt = 1; attempt <= 3; attempt++) await syncNow('token')

    expect((await readQueue())[0]).toMatchObject({ status: 'FAILED_RETRY', retryCount: 3, lastErrorCode: 'SYNC_IN_PROGRESS' })
    // The device tells the server how many times it has tried, so it can hand it over at the limit
    expect(posted().at(-1)[0].localAttemptCount).toBe(2)
  })

  it('reports the entry as waiting when the server answers the batch but not that event', async () => {
    const record = await enqueue('VISITOR_REGISTER', { name: 'Ravi' })
    fetchMock.mockImplementation(() => reply(200, { data: { batchId: 'b1', results: [] } }))

    await syncNow('token')

    expect((await readQueue())[0]).toMatchObject({ status: 'FAILED_RETRY', lastErrorCode: 'NO_RESULT' })
  })

  it('stops retrying once the server refuses the whole batch', async () => {
    await enqueue('VISITOR_REGISTER', {})
    fetchMock.mockImplementation(() => reply(403, { error: { code: 'PERMISSION_DENIED' } }))

    const meta = await syncNow('token')

    expect((await readQueue())[0]).toMatchObject({ status: 'FAILED_RETRY', retryCount: 1, lastErrorCode: 'PERMISSION_DENIED' })
    expect(meta).toMatchObject({ status: 'ERROR', lastError: 'PERMISSION_DENIED' })
  })

  it('shares one run between concurrent sync calls', async () => {
    const record = await enqueue('VISITOR_REGISTER', {})
    fetchMock.mockImplementation(() => results([record.clientEventId, 'APPLIED', null]))

    await Promise.all([syncNow('token'), syncNow('token')])

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reuses one device id across syncs', async () => {
    const first = await enqueue('VISITOR_REGISTER', {})
    fetchMock.mockImplementation((_url: string, init: { body: string }) =>
      results(...JSON.parse(init.body).events.map((e: { clientEventId: string }) => [e.clientEventId, 'APPLIED', null] as [string, EventResultStatus, null])),
    )
    await syncNow('token')
    await enqueue('VISIT_EXIT', {}, 'visit-2')
    await syncNow('token')

    const [a, b] = posted()
    expect(a[0].deviceId).toBe(b[0].deviceId)
    expect(first.clientEventId).not.toBe(b[0].clientEventId)
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
