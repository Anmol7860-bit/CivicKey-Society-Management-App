import { useEffect } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useResource } from '../society/useResource'
import { listNotifications } from './api'

/** Fired on window when a live notification arrives, so any screen can refresh itself. */
export const NOTIFICATION_ARRIVED = 'civickey:notification'

let socket: Socket | null = null

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
    return () => {
      socket?.disconnect()
      socket = null
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
