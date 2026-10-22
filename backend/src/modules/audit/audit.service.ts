import type { Database } from '../../db/client.js'
import { auditLogs } from '../../db/schema.js'

export type DbExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

export type AuditEventType =
  | 'AUTH_LOGIN_SUCCESS'
  | 'AUTH_LOGIN_FAILED'
  | 'AUTH_LOGIN_RATE_LIMITED'
  | 'AUTH_REFRESH_FAILED'
  | 'AUTH_REFRESH_REUSE_DETECTED'
  | 'AUTH_LOGOUT'
  | 'COMMITTEE_MEMBERSHIP_SET'
  | 'COMMITTEE_MEMBERSHIP_REMOVED'
  | 'AUTHORIZATION_DENIED'
  | 'SOCIETY_UPDATED'
  | 'BLOCK_CREATED'
  | 'BLOCK_UPDATED'
  | 'FLOOR_CREATED'
  | 'FLOOR_UPDATED'
  | 'FLAT_CREATED'
  | 'FLAT_UPDATED'
  | 'GATE_CREATED'
  | 'GATE_UPDATED'
  | 'STAFF_REGISTERED'
  | 'STAFF_UPDATED'
  | 'STAFF_PASS_REISSUED'
  | 'BILLING_RATE_SET'
  | 'INVOICES_GENERATED'
  | 'PAYMENT_RECORDED'
  | 'PAYMENT_REVERSED'
  | 'RESIDENT_REGISTERED'
  | 'RESIDENT_VERIFIED'
  | 'RESIDENT_REJECTED'
  | 'RESIDENT_UPDATED'

export interface AuditEvent {
  eventType: AuditEventType
  actorUserId?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  /** Must never contain passwords, tokens or hashes */
  metadata?: Record<string, unknown>
}

export async function recordAuditEvent(executor: DbExecutor, event: AuditEvent) {
  await executor.insert(auditLogs).values({
    eventType: event.eventType,
    actorUserId: event.actorUserId ?? null,
    ipAddress: event.ipAddress ?? null,
    userAgent: event.userAgent?.slice(0, 512) ?? null,
    metadata: event.metadata ?? {},
  })
}

/** Keeps audit rows useful for investigation without storing full phone numbers or emails. */
export function maskIdentifier(type: 'phone' | 'email', value: string) {
  if (type === 'phone') return `******${value.slice(-4)}`
  const [local = '', domain = ''] = value.split('@')
  return `${local.slice(0, 1)}***@${domain}`
}
