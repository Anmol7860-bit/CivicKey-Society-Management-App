import { z } from 'zod'

const uuid = z.uuid('Choose a valid record')

/** What a guard's device may replay. Anything needing a live answer is never queued. */
export const syncEventType = [
  'VISITOR_REGISTER',
  'VISIT_ENTRY_RECORD',
  'VISIT_EXIT',
  /** A visitor the guard admitted during an outage: physically in, with no resident decision */
  'MANUAL_OFFLINE_ENTRY',
] as const

/** After this many local attempts the device stops deciding and hands the event to the office. */
export const MAX_LOCAL_ATTEMPTS = 10
/** One POST carries at most this many events, as the design baseline fixes it. */
export const MAX_BATCH = 50

const syncEvent = z.strictObject({
  clientEventId: uuid,
  deviceId: z.string().trim().min(1).max(120),
  eventType: z.enum(syncEventType),
  /** The visit an entry or exit refers to; null when the event creates one */
  entityId: uuid.nullish(),
  payload: z.record(z.string(), z.unknown()).default({}),
  clientTs: z.iso.datetime({ offset: true }),
  /** The device's own ordering, replayed so the server applies a batch in creation order */
  sequence: z.number().int().min(0).optional(),
  /** How many times the device has already tried; at MAX_LOCAL_ATTEMPTS the office takes over */
  localAttemptCount: z.number().int().min(0).max(1000).default(0),
})

/**
 * A batch from one device. Each event is accepted or refused on its own, so one bad item never
 * blocks the rest of a guard's shift.
 */
export const syncBatchSchema = z.strictObject({
  batchId: uuid,
  events: z.array(syncEvent).min(1).max(MAX_BATCH),
})

export type SyncEvent = z.infer<typeof syncEvent>
export type SyncBatchBody = z.infer<typeof syncBatchSchema>
export type SyncEventType = (typeof syncEventType)[number]
