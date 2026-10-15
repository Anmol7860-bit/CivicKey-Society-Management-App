import { idbDelete, idbGet, idbGetAll, idbPut } from './db'

/**
 * Gate data entry a guard may record offline. Anything needing a live answer (a resident's approval,
 * the guard's decision on it) is never queued, so it can't look done while nobody was reached.
 */
export type OperationType = 'VISITOR_REGISTER' | 'VISIT_ENTRY_RECORD' | 'VISIT_EXIT'

export type QueueStatus = 'PENDING_SYNC' | 'SYNCING' | 'SYNCED' | 'FAILED_RETRY' | 'FAILED_ADMIN'

export interface QueueRecord {
  clientEventId: string
  operationType: OperationType
  entityId: string | null
  payload: Record<string, unknown>
  clientTs: string
  status: QueueStatus
  retryCount: number
  lastErrorCode: string | null
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
/** A record still failing after this many attempts needs an admin to look at it */
export const MAX_RETRIES = 10
const SYNCED_KEEP_MS = 24 * 60 * 60 * 1000

const WAITING: QueueStatus[] = ['PENDING_SYNC', 'SYNCING', 'FAILED_RETRY']
const EMPTY_META: SyncMetadata = { lastSyncedAt: null, status: 'IDLE', lastError: null, pendingCount: 0 }

const byClientTs = (a: QueueRecord, b: QueueRecord) => a.clientTs.localeCompare(b.clientTs)

export async function readQueue() {
  return (await idbGetAll<QueueRecord>('sync_queue')).sort(byClientTs)
}

export async function readMetadata(): Promise<SyncMetadata> {
  const { key: _key, ...meta } = (await idbGet<SyncMetadata & { key: string }>('sync_metadata', 'sync')) ?? { key: 'sync', ...EMPTY_META }
  return meta
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
  const record: QueueRecord = {
    clientEventId: crypto.randomUUID(),
    operationType,
    entityId,
    payload,
    clientTs: now,
    status: 'PENDING_SYNC',
    retryCount: 0,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  }
  await idbPut('sync_queue', record)
  await saveMetadata({})
  return record
}

type Outcome = { status: 'SYNCED' } | { status: 'FAILED_RETRY' | 'FAILED_ADMIN'; code: string; stop: boolean }

/**
 * Uploads one event. The backend must answer a clientEventId it has already stored with 2xx, so a
 * retry after a lost response never records the visit twice.
 */
async function upload(accessToken: string, record: QueueRecord): Promise<Outcome> {
  let res: Response
  try {
    res = await fetch('/api/v1/sync/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        clientEventId: record.clientEventId,
        operationType: record.operationType,
        entityId: record.entityId,
        payload: record.payload,
        clientTs: record.clientTs,
      }),
    })
  } catch {
    return { status: 'FAILED_RETRY', code: 'NETWORK_ERROR', stop: true }
  }
  if (res.ok) return { status: 'SYNCED' }

  const code: string = (await res.json().catch(() => null))?.error?.code ?? `HTTP_${res.status}`
  // Backend down, token expired or rate-limited: try this and the rest again later
  const unavailable = res.status >= 500 || [401, 408, 429].includes(res.status)
  if (unavailable && record.retryCount + 1 < MAX_RETRIES) return { status: 'FAILED_RETRY', code, stop: true }
  // The backend refused this record (validation, permission, state): retrying won't help
  return { status: 'FAILED_ADMIN', code, stop: unavailable }
}

/** Uploads waiting records oldest first. Stops at the first sign the backend is unreachable. */
async function drain(accessToken: string) {
  const waiting = (await readQueue()).filter((record) => WAITING.includes(record.status))
  if (waiting.length === 0) return readMetadata()

  await saveMetadata({ status: 'SYNCING' })
  let lastError: string | null = null
  for (const record of waiting) {
    await update(record, { status: 'SYNCING' })
    const outcome = await upload(accessToken, record)
    if (outcome.status === 'SYNCED') {
      await update(record, { status: 'SYNCED', lastErrorCode: null })
      continue
    }
    await update(record, { status: outcome.status, retryCount: record.retryCount + 1, lastErrorCode: outcome.code })
    lastError = outcome.code
    if (outcome.stop) break
  }

  // Synced records stay a day so the guard can see them, then leave the device
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
