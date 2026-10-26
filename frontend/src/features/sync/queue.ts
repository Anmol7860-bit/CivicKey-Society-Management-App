import { idbDelete, idbGet, idbGetAll, idbPut } from './db'

/**
 * Gate data entry a guard may record offline. Anything needing a live answer (a resident's approval,
 * the guard's decision on it) is never queued, so it can't look done while nobody was reached.
 */
export type OperationType = 'VISITOR_REGISTER' | 'VISIT_ENTRY_RECORD' | 'VISIT_EXIT' | 'MANUAL_OFFLINE_ENTRY'

/** Where a queued record stands on this device. */
export type QueueStatus = 'PENDING_SYNC' | 'SYNCING' | 'SYNCED' | 'FAILED_RETRY' | 'NEEDS_REVIEW' | 'FAILED_ADMIN'

/** What the server says about one event. Only APPLIED and DUPLICATE_IGNORED clear the device. */
export type EventResultStatus = 'APPLIED' | 'DUPLICATE_IGNORED' | 'FAILED_RETRY' | 'REJECTED' | 'NEEDS_REVIEW'

export interface QueueRecord {
  clientEventId: string
  operationType: OperationType
  entityId: string | null
  payload: Record<string, unknown>
  clientTs: string
  status: QueueStatus
  retryCount: number
  lastErrorCode: string | null
  /** The device's own ordering, so the server applies a batch as it was recorded */
  sequence: number
  createdAt: string
  updatedAt: string
}

export interface SyncMetadata {
  lastSyncedAt: string | null
  status: 'IDLE' | 'SYNCING' | 'ERROR'
  lastError: string | null
  pendingCount: number
}

/** Fired on window whenever the queue or sync status changes */
export const SYNC_CHANGED = 'civickey:sync-changed'
/** A record still failing after this many attempts is handed to the office, not retried forever */
export const MAX_RETRIES = 10
/** One POST carries at most this many events, as the design baseline fixes it */
export const MAX_BATCH = 50
const SYNCED_KEEP_MS = 24 * 60 * 60 * 1000

const WAITING: QueueStatus[] = ['PENDING_SYNC', 'SYNCING', 'FAILED_RETRY']
const EMPTY_META: SyncMetadata = { lastSyncedAt: null, status: 'IDLE', lastError: null, pendingCount: 0 }

const bySequence = (a: QueueRecord, b: QueueRecord) => a.sequence - b.sequence || a.clientTs.localeCompare(b.clientTs)

export async function readQueue() {
  return (await idbGetAll<QueueRecord>('sync_queue')).sort(bySequence)
}

export async function readMetadata(): Promise<SyncMetadata> {
  const { key: _key, ...meta } = (await idbGet<SyncMetadata & { key: string }>('sync_metadata', 'sync')) ?? { key: 'sync', ...EMPTY_META }
  return meta
}

/**
 * This install's device id. The server records which device sent each event, so a guard working
 * two phones does not look like one queue.
 */
export async function deviceId() {
  const stored = await idbGet<{ key: string; value: string }>('sync_metadata', 'device')
  if (stored?.value) return stored.value
  const value = crypto.randomUUID()
  await idbPut('sync_metadata', { key: 'device', value })
  return value
}

async function saveMetadata(changes: Partial<SyncMetadata>) {
  const queue = await readQueue()
  const meta = {
    ...(await readMetadata()),
    ...changes,
    pendingCount: queue.filter((record) => WAITING.includes(record.status)).length,
  }
  await idbPut('sync_metadata', { key: 'sync', ...meta })
  window.dispatchEvent(new Event(SYNC_CHANGED))
  return meta
}

async function update(record: QueueRecord, changes: Partial<QueueRecord>) {
  Object.assign(record, changes, { updatedAt: new Date().toISOString() })
  await idbPut('sync_queue', record)
}

/** Saves a gate event on the device. It uploads on the next sync, now if the backend is reachable. */
export async function enqueue(operationType: OperationType, payload: Record<string, unknown>, entityId: string | null = null) {
  const now = new Date().toISOString()
  const queue = await readQueue()
  const record: QueueRecord = {
    clientEventId: crypto.randomUUID(),
    operationType,
    entityId,
    payload,
    clientTs: now,
    status: 'PENDING_SYNC',
    retryCount: 0,
    lastErrorCode: null,
    sequence: (queue.at(-1)?.sequence ?? 0) + 1,
    createdAt: now,
    updatedAt: now,
  }
  await idbPut('sync_queue', record)
  await saveMetadata({})
  return record
}

interface BatchResult {
  clientEventId: string
  status: EventResultStatus
  entityId: string | null
  code: string | null
}

/** What a queued record becomes once the server has answered for it. */
const LANDED: Record<EventResultStatus, QueueStatus> = {
  APPLIED: 'SYNCED',
  DUPLICATE_IGNORED: 'SYNCED',
  FAILED_RETRY: 'FAILED_RETRY',
  REJECTED: 'FAILED_ADMIN',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
}

/**
 * Uploads one batch, oldest first. The server answers each event on its own, so a refusal on one
 * record never holds up the others.
 */
async function upload(accessToken: string, batch: QueueRecord[]): Promise<{ results: BatchResult[] } | { error: string }> {
  try {
    const res = await fetch('/api/v1/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        batchId: crypto.randomUUID(),
        events: batch.map((record) => ({
          clientEventId: record.clientEventId,
          deviceId: deviceKey,
          eventType: record.operationType,
          entityId: record.entityId,
          payload: record.payload,
          clientTs: record.clientTs,
          sequence: record.sequence,
          localAttemptCount: record.retryCount,
        })),
      }),
    })
    if (res.ok) return { results: (await res.json()).data.results as BatchResult[] }
    const code: string = (await res.json().catch(() => null))?.error?.code ?? `HTTP_${res.status}`
    return { error: code }
  } catch {
    return { error: 'NETWORK_ERROR' }
  }
}

let deviceKey = 'unknown'

/** Uploads waiting records oldest first, a batch at a time. Stops if the backend is unreachable. */
async function drain(accessToken: string) {
  deviceKey = await deviceId()
  const waiting = (await readQueue()).filter((record) => WAITING.includes(record.status))
  if (waiting.length === 0) return readMetadata()

  await saveMetadata({ status: 'SYNCING' })
  let lastError: string | null = null

  for (let from = 0; from < waiting.length; from += MAX_BATCH) {
    const batch = waiting.slice(from, from + MAX_BATCH)
    for (const record of batch) await update(record, { status: 'SYNCING' })

    const answer = await upload(accessToken, batch)
    if ('error' in answer) {
      // The whole batch went nowhere: it stays queued, and the rest waits for the next sync
      for (const record of batch) {
        await update(record, { status: 'FAILED_RETRY', retryCount: record.retryCount + 1, lastErrorCode: answer.error })
      }
      lastError = answer.error
      break
    }

    const byId = new Map(answer.results.map((result) => [result.clientEventId, result]))
    for (const record of batch) {
      const result = byId.get(record.clientEventId)
      // The server answered the batch but not this record: treat it as still waiting
      if (!result) {
        await update(record, { status: 'FAILED_RETRY', retryCount: record.retryCount + 1, lastErrorCode: 'NO_RESULT' })
        continue
      }
      await update(record, {
        status: LANDED[result.status],
        retryCount: result.status === 'FAILED_RETRY' ? record.retryCount + 1 : record.retryCount,
        lastErrorCode: result.code,
        entityId: result.entityId ?? record.entityId,
      })
      if (result.status !== 'APPLIED' && result.status !== 'DUPLICATE_IGNORED') lastError = result.code ?? result.status
    }
  }

  // Synced records stay a day so the guard can see them, then leave the device. A refusal or a
  // record waiting on the office stays until someone deals with it.
  const cutoff = new Date(Date.now() - SYNCED_KEEP_MS).toISOString()
  for (const record of await readQueue()) {
    if (record.status === 'SYNCED' && record.updatedAt < cutoff) await idbDelete('sync_queue', record.clientEventId)
  }

  return saveMetadata(
    lastError ? { status: 'ERROR', lastError } : { status: 'IDLE', lastError: null, lastSyncedAt: new Date().toISOString() },
  )
}

let running: Promise<SyncMetadata> | null = null

/** Runs one sync. Concurrent calls share it, and a Web Lock keeps two tabs from uploading the same record. */
export function syncNow(accessToken: string) {
  const job = () => drain(accessToken)
  running ??= (navigator.locks ? navigator.locks.request('civickey-sync', job) : job()).finally(() => {
    running = null
  })
  return running
}
