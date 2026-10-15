import { useEffect, useState } from 'react'
import { readMetadata, readQueue, SYNC_CHANGED, syncNow, type QueueRecord, type SyncMetadata } from './queue'

/** While the device is online, retry waiting records this often in case the backend was down */
const AUTO_SYNC_MS = 30_000

/** Syncs on start, when the browser comes back online, and every AUTO_SYNC_MS. Mount once per signed-in guard. */
export function useAutoSync(accessToken: string) {
  useEffect(() => {
    const tick = () => {
      if (navigator.onLine) syncNow(accessToken).catch(() => {}) // the queue records the failure
    }
    tick()
    window.addEventListener('online', tick)
    const timer = window.setInterval(tick, AUTO_SYNC_MS)
    return () => {
      window.removeEventListener('online', tick)
      clearInterval(timer)
    }
  }, [accessToken])
}

/** The sync status and queue, kept current as they change. */
export function useSyncState() {
  const [state, setState] = useState<{ meta: SyncMetadata; queue: QueueRecord[] } | null>(null)
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    let active = true
    const load = () =>
      Promise.all([readMetadata(), readQueue()]).then(
        ([meta, queue]) => active && setState({ meta, queue }),
        () => {}, // IndexedDB unavailable (e.g. private mode): nothing to show
      )
    const connectivity = () => setOnline(navigator.onLine)
    void load()
    window.addEventListener(SYNC_CHANGED, load)
    window.addEventListener('online', connectivity)
    window.addEventListener('offline', connectivity)
    return () => {
      active = false
      window.removeEventListener(SYNC_CHANGED, load)
      window.removeEventListener('online', connectivity)
      window.removeEventListener('offline', connectivity)
    }
  }, [])

  return { ...state, online }
}
