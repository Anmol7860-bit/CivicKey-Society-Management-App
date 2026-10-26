import { notificationOutbox, type notificationEvent } from '../../db/schema.js'
import type { DbExecutor } from '../audit/audit.service.js'

export type NotificationEvent = (typeof notificationEvent.enumValues)[number]

export interface OutboxEvent {
  societyId: string
  eventType: NotificationEvent
  /** What the event is about, so a reader can open it */
  entityType: 'visit' | 'staff' | 'invoice' | 'payment' | 'receipt' | 'task' | 'sync'
  entityId?: string | null
  /** Who should be told. An empty list is allowed and simply tells nobody. */
  recipientIds: string[]
  /**
   * Values the message is built from. Never a full government ID, a token, a password or another
   * flat's balance: this travels to a lock screen and into an email.
   */
  payload?: Record<string, unknown>
}

/**
 * Records that something happened and someone should hear about it.
 *
 * Call this with the transaction that made the change, never with the bare database handle. The
 * event and the change then commit together: no notification about a visitor who was never
 * registered, and no registration that quietly told nobody.
 */
export async function enqueueNotification(executor: DbExecutor, event: OutboxEvent) {
  // Duplicate recipients would each get their own row; one person hears about a thing once
  const recipientIds = [...new Set(event.recipientIds)]
  const [row] = await executor
    .insert(notificationOutbox)
    .values({
      societyId: event.societyId,
      eventType: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      recipientIds,
      payload: event.payload ?? {},
    })
    .returning({ id: notificationOutbox.id })
  return row!
}
