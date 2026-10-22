import { call } from '../society/api'

/** One line of the audit trail, as the Security activity panel reads it. */
export interface AuditEntry {
  id: string
  eventType: string
  createdAt: string
  metadata: Record<string, unknown>
  actor: { id: string; name: string; phone: string | null } | null
}

export function listAuditLogs(token: string, societyId: string, filters: { event?: string; user?: string } = {}) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString()
  return call<AuditEntry[]>(token, 'GET', `/societies/${societyId}/audit-logs${query ? `?${query}` : ''}`)
}
