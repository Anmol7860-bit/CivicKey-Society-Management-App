import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../auth/api'

export interface Resource<T> {
  data?: T
  /** The API's message, absent when the load succeeded */
  error?: string
  loading: boolean
  reload: () => void
}

/**
 * Loads a resource and keeps it current. `load` is null while a required selection is missing,
 * which leaves the resource idle rather than firing a request for nothing. The caller owns the
 * dependency list, exactly as useEffect does.
 */
export function useResource<T>(load: (() => Promise<T>) | null, deps: unknown[]): Resource<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: load !== null })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!load) return setState({ loading: false })
    let active = true
    setState((previous) => ({ ...previous, loading: true, error: undefined }))
    load().then(
      (data) => active && setState({ data, loading: false }),
      // What was already loaded is kept beside the error: a failed refresh should not blank a
      // screen the reader was using, and a first load has nothing to keep anyway
      (error: unknown) =>
        active &&
        setState((previous) => ({ ...previous, loading: false, error: error instanceof ApiError ? error.message : String(error) })),
    )
    return () => {
      active = false
    }
    // The caller's deps decide when to reload; `load` is a new closure on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt])

  return { ...state, reload: useCallback(() => setAttempt((n) => n + 1), []) }
}
