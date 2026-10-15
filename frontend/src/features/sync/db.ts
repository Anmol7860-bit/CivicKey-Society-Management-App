// The guard device's local IndexedDB: the offline sync queue, cached reference data and sync status.

export type StoreName = 'sync_queue' | 'offline_cache' | 'sync_metadata'

let opening: Promise<IDBDatabase> | null = null

function openDb() {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('civickey', 1)
    req.onupgradeneeded = () => {
      const db = req.result
      const queue = db.createObjectStore('sync_queue', { keyPath: 'clientEventId' })
      queue.createIndex('status', 'status')
      queue.createIndex('clientTs', 'clientTs')
      queue.createIndex('operationType', 'operationType')
      db.createObjectStore('offline_cache', { keyPath: 'key' })
      db.createObjectStore('sync_metadata', { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }).catch((error) => {
    opening = null
    throw error
  })
  return opening
}

async function run<T>(name: StoreName, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest) {
  const req = op((await openDb()).transaction(name, mode).objectStore(name))
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
  })
}

export const idbGet = <T>(name: StoreName, key: string) => run<T | undefined>(name, 'readonly', (s) => s.get(key))
export const idbGetAll = <T>(name: StoreName) => run<T[]>(name, 'readonly', (s) => s.getAll())
export const idbPut = (name: StoreName, value: object) => run<void>(name, 'readwrite', (s) => s.put(value))
export const idbDelete = (name: StoreName, key: string) => run<void>(name, 'readwrite', (s) => s.delete(key))

/** Test-only: drops the connection so the next call opens a fresh database */
export function closeDbForTests() {
  void opening?.then((db) => db.close())
  opening = null
}
