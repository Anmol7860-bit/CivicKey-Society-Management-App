import { z } from 'zod'
import { staffRejectionReason, vehicleType, visitPurpose, visitorPassType } from '../../db/schema.js'

const name = z.string().trim().min(2, 'Give the name').max(120)
const phone = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, 'Give a 10-digit Indian mobile number')
const uuid = z.uuid('Choose a valid record')
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
const clockTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use the format HH:MM')
/** As printed on the plate: letters, digits, spaces and hyphens only */
const vehicleNumber = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9 -]{3,15}$/, 'Give the number as it is on the plate')
const note = z.string().trim().max(200)
const people = z.number().int().min(1).max(50)
const reason = z.string().trim().min(3, 'Give a reason').max(200)

export const createPassSchema = z
  .strictObject({
    visitorName: name,
    visitorPhone: phone,
    purpose: z.enum(visitPurpose.enumValues).default('GUEST'),
    people: people.default(1),
    validOn: isoDate,
    validFrom: clockTime,
    validUntil: clockTime,
    vehicleNumber: vehicleNumber.optional(),
    passType: z.enum(visitorPassType.enumValues).default('ONE_ENTRY'),
    note: note.optional(),
  })
  .refine((body) => body.validUntil > body.validFrom, {
    message: 'The pass must end after it starts',
    path: ['validUntil'],
  })

/** The six digits the visitor reads out at the gate. */
export const entryCodeSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'An entry code is 6 digits'),
})

export const registerVisitSchema = z
  .strictObject({
    flatId: uuid,
    gateId: uuid.optional(),
    visitorName: name,
    visitorPhone: phone,
    purpose: z.enum(visitPurpose.enumValues),
    company: z.string().trim().max(120).optional(),
    people: people.default(1),
    vehicleNumber: vehicleNumber.optional(),
    note: note.optional(),
    /** The stored image of the visitor, as returned by POST /files */
    photoReference: z.uuid().optional(),
    /** The resident the visitor asked for; the approval is routed to them */
    intendedResidentId: uuid.optional(),
    /** When the visit is expected. Both parts together, or neither, which means now. */
    expectedDate: isoDate.optional(),
    expectedTime: clockTime.optional(),
    /** One id per filled-in form, so a retry after a lost answer cannot register the visit twice */
    clientEventId: z.uuid().optional(),
    /** Present when the visitor arrived holding a pass, which approves the visit outright */
    entryCode: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'An entry code is 6 digits')
      .optional(),
  })
  // "Other" says nothing by itself, so the guard writes what this visit is
  .refine((body) => body.purpose !== 'OTHER' || Boolean(body.note), {
    message: 'Say what the visitor is here for',
    path: ['note'],
  })

/**
 * The same form as it arrives from a guard standing at the gate, where the camera and the clock
 * are to hand. A replay out of a device's offline queue uses the schema above: it was filled in
 * with no server to store a photograph on.
 */
export const registerVisitAtGateSchema = registerVisitSchema
  // A pass holder was identified when the resident issued the pass, and the pass carries its own
  // window; everyone the guard registers by hand is photographed and timed at the gate.
  .refine((body) => Boolean(body.entryCode || body.photoReference), {
    message: 'Take the visitor\'s photograph',
    path: ['photoReference'],
  })
  .refine((body) => Boolean(body.entryCode || body.expectedDate), {
    message: 'Give the expected date',
    path: ['expectedDate'],
  })
  .refine((body) => Boolean(body.entryCode || body.expectedTime), {
    message: 'Give the expected time',
    path: ['expectedTime'],
  })
  // Somebody asked for by name is a visit to a person; a delivery or a cab is a visit to the flat
  .refine((body) => body.purpose !== 'GUEST' || Boolean(body.entryCode || body.intendedResidentId), {
    message: 'Choose who the visitor is here to see',
    path: ['intendedResidentId'],
  })

/** What the resident (or the guard, after the intercom call) decided. */
export const decideVisitSchema = z
  .strictObject({
    decision: z.enum(['APPROVED', 'LEAVE_AT_GATE', 'DENIED']),
    reason: reason.optional(),
  })
  .refine((body) => body.decision !== 'DENIED' || body.reason === undefined || body.reason.length > 0, {
    message: 'Give a reason',
    path: ['reason'],
  })

export const listVisitsSchema = z.strictObject({
  status: z.enum(['AWAITING_APPROVAL', 'APPROVED', 'LEAVE_AT_GATE', 'DENIED', 'ENTERED', 'CLOSED']).optional(),
  gateId: uuid.optional(),
  flatId: uuid.optional(),
  /** Defaults to today; the gate rarely looks further back */
  date: isoDate.optional(),
  search: z.string().trim().min(1).max(60).optional(),
})

/**
 * A request id for one tap of Entry, Exit or Reject. The guard's screen sends the same one on a
 * retry, so a lost response cannot become a second movement.
 */
const idempotencyKey = z.string().trim().min(8, 'A request id is at least 8 characters').max(150)

export const staffMovementSchema = z.strictObject({
  gateId: uuid.optional(),
  idempotencyKey: idempotencyKey.optional(),
})

export const staffRejectionSchema = z
  .strictObject({
    gateId: uuid.optional(),
    reason: z.enum(staffRejectionReason.enumValues),
    /** Required for OTHER, so a refusal is never unexplained */
    note: z.string().trim().min(3, 'Say what happened').max(200).optional(),
    idempotencyKey: idempotencyKey.optional(),
  })
  .refine((body) => body.reason !== 'OTHER' || body.note !== undefined, {
    message: 'Describe the reason',
    path: ['note'],
  })

export const staffMovementHistorySchema = z.strictObject({
  staffId: uuid.optional(),
  /** The work type as written on the profile, or the staff kind */
  staffType: z.string().trim().min(2).max(60).optional(),
  gateId: uuid.optional(),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  eventType: z.enum(['ENTRY', 'EXIT', 'ENTRY_REJECTED']).optional(),
  verificationStatus: z.enum(['VERIFIED', 'REJECTED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

/** One day of the gate log; defaults to today, which is the shift the guard is standing in */
export const gateLogSchema = z.strictObject({ on: isoDate.optional() })

export const visitorLookupSchema = z.strictObject({ phone })

export const recordEntrySchema = z.strictObject({ gateId: uuid.optional() })

export const addVehicleSchema = z.strictObject({
  number: vehicleNumber,
  vehicleType: z.enum(vehicleType.enumValues).default('CAR'),
  makeColour: z.string().trim().max(60).optional(),
})

export const accessRequestSchema = z.strictObject({
  flatId: uuid,
  kind: z.enum(['HOUSEHOLD_MEMBER', 'DAILY_HELP']),
  name,
  phone,
  /** Spouse or Son for a household member; Maid, Cook or Driver for daily help */
  relationship: z.string().trim().max(60).optional(),
  accessLevel: z.enum(['FULL', 'VIEW_ONLY']).optional(),
  timings: z.string().trim().max(40).optional(),
})

export const decideAccessRequestSchema = z.strictObject({
  status: z.enum(['APPROVED', 'REJECTED']),
  reason: reason.optional(),
})

export const markLeaveSchema = z.strictObject({ onDate: isoDate.optional() })

export type CreatePassBody = z.infer<typeof createPassSchema>
export type RegisterVisitBody = z.infer<typeof registerVisitSchema>
export type DecideVisitBody = z.infer<typeof decideVisitSchema>
export type ListVisitsQuery = z.infer<typeof listVisitsSchema>
export type GateLogQuery = z.infer<typeof gateLogSchema>
export type StaffMovementBody = z.infer<typeof staffMovementSchema>
export type StaffRejectionBody = z.infer<typeof staffRejectionSchema>
export type StaffMovementHistoryQuery = z.infer<typeof staffMovementHistorySchema>
export type AddVehicleBody = z.infer<typeof addVehicleSchema>
export type AccessRequestBody = z.infer<typeof accessRequestSchema>
export type DecideAccessRequestBody = z.infer<typeof decideAccessRequestSchema>
