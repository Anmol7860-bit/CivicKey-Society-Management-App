import { useEffect, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useResource } from '../society/useResource'
import { listNotifications } from './api'

/** Fired on window when a live notification arrives, so any screen can refresh itself. */
export const NOTIFICATION_ARRIVED = 'civickey:notification'
/** Fired when the live connection comes up or goes down. */
export const NOTIFICATION_LIVE = 'civickey:notification-live'

let socket: Socket | null = null
/** null until the first attempt settles, so nothing is claimed either way while connecting. */
let live: boolean | null = null

function setLive(next: boolean | null) {
  if (live === next) return
  live = next
  window.dispatchEvent(new Event(NOTIFICATION_LIVE))
}

/**
 * Whether live updates are actually arriving.
 *
 * A screen that shows notifications has to be able to say so when they are not: the application
 * must never imply real-time delivery it is not getting.
 */
export function useLiveStatus() {
  const [value, setValue] = useState(live)
  useEffect(() => {
    const sync = () => setValue(live)
    sync()
    window.addEventListener(NOTIFICATION_LIVE, sync)
    return () => window.removeEventListener(NOTIFICATION_LIVE, sync)
  }, [])
  return value
}

/**
 * Keeps one live connection for the signed-in person.
 *
 * The socket carries the access token and the server decides which rooms it joins; the client
 * never asks for one. A dropped connection is not an error worth showing: the notification is
 * already stored, and the next load reads it.
 */
export function useLiveNotifications(accessToken: string) {
  useEffect(() => {
    if (!accessToken) return
    socket = io({ path: '/api/v1/socket.io', auth: { token: accessToken }, transports: ['websocket', 'polling'] })
    socket.on('notification', (payload: unknown) => {
      window.dispatchEvent(new CustomEvent(NOTIFICATION_ARRIVED, { detail: payload }))
    })
    socket.on('connect', () => setLive(true))
    socket.on('disconnect', () => setLive(false))
    socket.on('connect_error', () => setLive(false))
    return () => {
      socket?.disconnect()
      socket = null
      setLive(null)
    }
  }, [accessToken])
}

/** This person's notifications, refreshed when a live one arrives. */
export function useNotifications(accessToken: string) {
  const { data, error, loading, reload } = useResource(() => listNotifications(accessToken), [accessToken])

  useEffect(() => {
    window.addEventListener(NOTIFICATION_ARRIVED, reload)
    return () => window.removeEventListener(NOTIFICATION_ARRIVED, reload)
  }, [reload])

  return { items: data?.items, unread: data?.unread ?? 0, loading, error, reload }
}
