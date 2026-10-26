import { z } from 'zod'

const uuid = z.uuid('Choose a valid record')

/** What a guard's device may replay. Anything needing a live answer is never queued. */
export const syncOperation = ['VISITOR_REGISTER', 'VISIT_ENTRY_RECORD', 'VISIT_EXIT'] as const

/**
 * One queued gate event. The device sends them one at a time, oldest first, and keeps retrying
 * until it gets an answer, so clientEventId is the whole idempotency contract.
 */
export const syncEventSchema = z.strictObject({
  clientEventId: uuid,
  operationType: z.enum(syncOperation),
  /** The visit an entry or exit refers to; null when the event creates one */
  entityId: uuid.nullish(),
  payload: z.record(z.string(), z.unknown()).default({}),
  clientTs: z.iso.datetime({ offset: true }),
})

export type SyncEventBody = z.infer<typeof syncEventSchema>
export type SyncOperation = (typeof syncOperation)[number]
