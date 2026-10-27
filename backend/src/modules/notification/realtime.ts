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
/** One session's own room, so a logout on one device leaves the others connected. */
const roomForSession = (sessionId: string) => `session:${sessionId}`

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
      const { sub, sid } = await verifyAccessToken(token)
      if (typeof sub !== 'string' || typeof sid !== 'string') return next(new Error('Authentication failed'))
      // Read the society from the database, not the token: a token outlives a transfer
      const [user] = await db.select({ societyId: users.societyId, isActive: users.isActive }).from(users).where(eq(users.id, sub))
      if (!user?.isActive) return next(new Error('Authentication failed'))
      socket.data.userId = sub
      socket.data.sessionId = sid
      socket.data.societyId = user.societyId
      next()
    } catch {
      next(new Error('Authentication failed'))
    }
  })

  io.on('connection', (socket) => {
    const { userId, sessionId, societyId } = socket.data as { userId: string; sessionId: string; societyId: string | null }
    void socket.join(roomForUser(userId))
    void socket.join(roomForSession(sessionId))
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

/** Drops the connections a logged-out session left behind. Its other sessions stay connected. */
export function disconnectSession(sessionId: string) {
  io?.in(roomForSession(sessionId)).disconnectSockets(true)
}

export async function closeRealtime() {
  await io?.close()
  io = null
}
