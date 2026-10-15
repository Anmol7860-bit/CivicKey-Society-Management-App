import { idbDelete, idbGet, idbPut } from './db'

/**
 * Reference data a guard may use offline, and how long each copy is trusted. A copy older than this
 * is discarded rather than used; screens refetch and re-cache it whenever they load online.
 */
export const CACHE_MAX_AGE_MS = {
  /** Active pre-approved visitor passes: residents create and cancel these through the day */
  visitorPasses: 15 * 60 * 1000,
  /** Valid staff passes */
  staffPasses: 12 * 60 * 60 * 1000,
  /** Flats and other reference data */
  flats: 24 * 60 * 60 * 1000,
} as const

export type CacheKey = keyof typeof CACHE_MAX_AGE_MS

interface CacheEntry<T> {
  key: CacheKey
  data: T
  cachedAt: string
}

export async function cachePut<T>(key: CacheKey, data: T) {
  await idbPut('offline_cache', { key, data, cachedAt: new Date().toISOString() } satisfies CacheEntry<T>)
}

/** The cached copy, or null when there is none or it has expired (expired copies are deleted). */
export async function cacheGet<T>(key: CacheKey): Promise<CacheEntry<T> | null> {
  const entry = await idbGet<CacheEntry<T>>('offline_cache', key)
  if (!entry) return null
  if (Date.now() - Date.parse(entry.cachedAt) > CACHE_MAX_AGE_MS[key]) {
    await idbDelete('offline_cache', key)
    return null
  }
  return entry
}
