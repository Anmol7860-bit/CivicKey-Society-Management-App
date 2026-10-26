import type { Server as HttpServer } from 'node:http'
import { eq } from 'drizzle-orm'
import { Server, type Socket } from 'socket.io'
import { env } from '../../config/env.js'
import { db } from '../../db/client.js'
import { users } from '../../db/schema.js'
import { logger } from '../../lib/logger.js'
import { verifyAccessToken } from '../auth/tokens.js'

let io: Server | null = null

/** A person's own room. Derived from the verified token, never from anything the client sends. */
const roomForUser = (userId: string) => `user:${userId}`
const roomForSociety = (societyId: string) => `society:${societyId}`

/**
 * Starts the realtime server.
 *
 * A connection must present a valid access token and is then put into rooms the server chooses
 * from the verified identity. A client-supplied room name is never honoured: a join request is
 * the obvious way to listen to someone else's notifications.
 */
export function attachRealtime(server: HttpServer) {
  io = new Server(server, {
    path: '/api/v1/socket.io',
    cors: { origin: env.CORS_ORIGIN.split(','), credentials: true },
    serveClient: false,
  })

  io.use(async (socket: Socket, next) => {
    const token = socket.handshake.auth?.token
    if (typeof token !== 'string' || !token) return next(new Error('Authentication required'))
    try {
      const { sub } = await verifyAccessToken(token)
      if (typeof sub !== 'string') return next(new Error('Authentication failed'))
      // Read the society from the database, not the token: a token outlives a transfer
      const [user] = await db.select({ societyId: users.societyId, isActive: users.isActive }).from(users).where(eq(users.id, sub))
      if (!user?.isActive) return next(new Error('Authentication failed'))
      socket.data.userId = sub
      socket.data.societyId = user.societyId
      next()
    } catch {
      next(new Error('Authentication failed'))
    }
  })

  io.on('connection', (socket) => {
    const { userId, societyId } = socket.data as { userId: string; societyId: string | null }
    void socket.join(roomForUser(userId))
    if (societyId) void socket.join(roomForSociety(societyId))
    // There is no join handler on purpose: rooms are assigned above and cannot be requested
    socket.on('error', (error) => logger.debug({ err: error }, 'Socket error'))
  })

  return io
}

/** Sends a live event to one person's own room. Does nothing when realtime is not running. */
export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(roomForUser(userId)).emit(event, payload)
}

/** Sends a live event to everyone in a society, used for gate-wide notices. */
export function emitToSociety(societyId: string, event: string, payload: unknown) {
  io?.to(roomForSociety(societyId)).emit(event, payload)
}

/** Drops every connection for one person, so a logout does not leave a live socket behind. */
export function disconnectUser(userId: string) {
  io?.in(roomForUser(userId)).disconnectSockets(true)
}

export async function closeRealtime() {
  await io?.close()
  io = null
}
