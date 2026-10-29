import { IDBFactory } from 'fake-indexeddb'
import { QueuedOfflineError } from '../auth/api'
import { closeDbForTests } from '../sync/db'
import { readQueue } from '../sync/queue'
import { recordEntry, recordExit, recordManualOfflineEntry, registerVisit } from './api'

const fetchMock = vi.fn()

const visit = {
  flatId: 'f1',
  visitorName: 'Dev Courier',
  visitorPhone: '9833333333',
  purpose: 'DELIVERY' as const,
  people: 1,
}

beforeEach(() => {
  closeDbForTests()
  globalThis.indexedDB = new IDBFactory()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe('gate actions while the gate is offline', () => {
  it('does not keep a registration on the device: registering is online-only', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    // The guard is told the gate is offline rather than left believing the visitor is registered,
    // and no photograph or personal detail is parked on a shared tablet.
    await expect(registerVisit('token', 'soc-1', visit)).rejects.toThrow()
    expect(await readQueue()).toEqual([])
  })

  it('saves an entry and an exit against the visit they belong to', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(recordEntry('token', 'visit-1', 'gate-1')).rejects.toBeInstanceOf(QueuedOfflineError)
    await expect(recordExit('token', 'visit-1')).rejects.toBeInstanceOf(QueuedOfflineError)

    expect((await readQueue()).map((r) => [r.operationType, r.entityId, r.sequence])).toEqual([
      ['VISIT_ENTRY_RECORD', 'visit-1', 1],
      ['VISIT_EXIT', 'visit-1', 2],
    ])
  })

  it('records a visitor let in during an outage as needing a reason and a review', async () => {
    const queued = await recordManualOfflineEntry({ ...visit, reason: 'Resident did not answer' })

    expect(queued).toMatchObject({ operationType: 'MANUAL_OFFLINE_ENTRY', status: 'PENDING_SYNC' })
    expect(queued.payload.reason).toBe('Resident did not answer')
    // Nothing was sent: there was nobody to ask
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('passes a refusal from the server through instead of queueing it', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'NOT_YOUR_FLAT', message: 'No' } }), { status: 403 }))

    await expect(registerVisit('token', 'soc-1', visit)).rejects.toMatchObject({ code: 'NOT_YOUR_FLAT' })
    expect(await readQueue()).toEqual([])
  })
})
