import { Router } from 'express'
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { auditLogs, users } from '../../db/schema.js'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { parseOrThrow } from '../../middleware/validateBody.js'

const listSchema = z.strictObject({
  /** One event type, as the Event select offers them */
  event: z.string().trim().max(64).optional(),
  /** Matches the actor's name or mobile number, as typed */
  user: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

/** The Security activity panel: who did what, newest first. Read-only; nothing here is editable. */
export function createAuditRouter() {
  const router = Router()

  router.get('/societies/:societyId/audit-logs', requireAuth, requirePermission('AUDIT_VIEW'), async (req, res) => {
    const query = parseOrThrow(listSchema, req.query)
    const societyId = req.params.societyId as string
    // Scope first: an Admin reads their own society's trail and no other
    if (req.ctx!.societyId !== societyId) {
      return res.status(403).json({
        error: {
          code: 'CROSS_SOCIETY_ACCESS',
          message: 'This resource belongs to another society',
        },
      })
    }

    const rows = await db
      .select({
        id: auditLogs.id,
        eventType: auditLogs.eventType,
        createdAt: auditLogs.createdAt,
        metadata: auditLogs.metadata,
        actor: { id: users.id, name: users.name, phone: users.phone },
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(
        and(
          // Either the actor belongs to this society, or the event names it in its metadata
          or(eq(users.societyId, societyId), sql`${auditLogs.metadata}->>'societyId' = ${societyId}`),
          ...(query.event ? [eq(auditLogs.eventType, query.event)] : []),
          ...(query.user ? [or(ilike(users.name, `%${query.user}%`), ilike(users.phone, `%${query.user}%`))!] : []),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(query.limit ?? 50)

    return res.json({ data: rows })
  })

  return router
}
