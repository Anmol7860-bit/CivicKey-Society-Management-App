import { z } from 'zod'
import { gender, policeVerification, staffKind, staffShift } from '../../db/schema.js'
import { identityRefinements, identitySchema } from '../access/identity.js'

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
const mobile = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, 'Phone must be a 10-digit Indian mobile number')
const kind = z.enum(staffKind.enumValues)
const shift = z.enum(staffShift.enumValues)
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const
/** Sent as a set and stored in week order, so 'SUN,MON' and 'MON,SUN' are the same record */
const workingDays = z
  .array(z.enum(DAYS))
  .max(7)
  .transform((days) => [...new Set(days)].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)).join(','))

/** The flats a daily help or vendor works for, with when they are expected */
const flatsServed = z
  .array(
    z.strictObject({
      flatId: z.uuid(),
      timeWindow: z.string().trim().max(40).optional(),
    }),
  )
  .max(40)

const common = {
  name: z.string().trim().min(2, 'Name is required').max(120),
  phone: mobile,
  workType: z.string().trim().min(2).max(60).optional(),
  agency: z.string().trim().min(2).max(120).optional(),
  gateId: z.uuid().nullable().optional(),
  shift: shift.nullable().optional(),
  policeVerification: z.enum(policeVerification.enumValues).optional(),
  gender: z.enum(gender.enumValues).optional(),
  homeAddress: z.string().trim().max(500).optional(),
  workingDays: workingDays.optional(),
  /** The stored image this person is identified by, as returned by POST /files */
  photoReference: z.uuid('A photograph is required'),
  passValidFrom: isoDate.optional(),
  passValidUntil: isoDate.nullable().optional(),
  ...identitySchema,
}

const periodOrdered = (body: { passValidFrom?: string; passValidUntil?: string | null }) =>
  !body.passValidUntil || !body.passValidFrom || body.passValidUntil >= body.passValidFrom
const periodMessage = {
  message: 'The pass cannot end before it starts',
  path: ['passValidUntil'],
}

export const createStaffSchema = identityRefinements(
  z
    .strictObject({ kind, ...common, flatsServed: flatsServed.optional() })
    // A guard is posted to a gate on a shift; daily help works for flats, not a gate
    .refine((body) => body.kind !== 'GUARD' || (body.gateId !== undefined && body.gateId !== null), {
      message: 'Choose the gate this guard is posted to',
      path: ['gateId'],
    })
    .refine((body) => body.kind !== 'GUARD' || (body.shift !== undefined && body.shift !== null), {
      message: 'Choose the shift this guard works',
      path: ['shift'],
    })
    .refine((body) => body.kind !== 'DAILY_HELP' || (body.flatsServed?.length ?? 0) > 0, {
      message: 'Choose at least one flat this person works for',
      path: ['flatsServed'],
    })
    .refine(periodOrdered, periodMessage),
)

export const updateStaffSchema = identityRefinements(
  z
    .strictObject({
      ...common,
      name: common.name.optional(),
      phone: mobile.optional(),
      photoReference: common.photoReference.optional(),
      /** Replaces the whole set when given; leave it out to keep the flats as they are */
      flatsServed: flatsServed.optional(),
      status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
      /** Required when the change deactivates the staff member; kept in the audit trail */
      reason: z.string().trim().min(3, 'Give a reason').max(200).optional(),
    })
    .refine((body) => Object.keys(body).some((key) => key !== 'reason'), {
      message: 'Provide at least one field to update',
    })
    .refine((body) => body.status !== 'INACTIVE' || body.reason !== undefined, {
      message: 'Give a reason for deactivating this record',
      path: ['reason'],
    })
    .refine(periodOrdered, periodMessage),
)

/** Filters for the staff list: the tab is the kind, plus the search box and shift select above it */
export const listStaffSchema = z.strictObject({
  kind: kind.optional(),
  /** Matches a name or a mobile number, as typed */
  search: z.string().trim().max(60).optional(),
  shift: shift.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  /** The list is read on a phone, so it comes a page at a time rather than whole */
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

export type CreateStaffBody = z.infer<typeof createStaffSchema>
export type UpdateStaffBody = z.infer<typeof updateStaffSchema>
export type ListStaffQuery = z.infer<typeof listStaffSchema>

/** Reading a government ID is always for a reason, and the reason is kept in the audit log. */
export const revealIdSchema = z.strictObject({
  reason: z.string().trim().min(5, 'Say why the ID is being read').max(200),
})

export type RevealIdBody = z.infer<typeof revealIdSchema>
