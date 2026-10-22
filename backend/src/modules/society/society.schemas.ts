import { z } from 'zod'

const atLeastOneField = (body: object) => Object.keys(body).some((key) => key !== 'reason')
const noFields = { message: 'Provide at least one field to update' }

/** Why a record was deactivated. Kept in the audit trail with the actor, never on the record. */
const reason = z.string().trim().min(3, 'Give a reason').max(200)
const reasonGiven = (body: { status?: string; reason?: string }) => body.status !== 'INACTIVE' || body.reason !== undefined
const reasonRequired = { message: 'Give a reason for deactivating this record', path: ['reason'] }

const blockName = z.string().trim().min(1).max(64)
/** Free text, never parsed as a number: B2, Ground, 1st Floor, Terrace */
const floorLabel = z
  .string()
  .transform((label) => label.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'Floor label is required').max(80))
/** Negative values let basements sort first */
const sortOrder = z.number().int().min(-1000).max(1000).nullable()
const flatNumber = z.string().trim().min(1).max(16)
/** Co-owner/flatmate cap; null means sharing with no cap. Only meaningful while sharing is allowed. */
const maxOccupants = z.number().int().min(2).max(50).nullable()
const status = z.enum(['ACTIVE', 'INACTIVE'])
/** An optional free-text field: blank clears it */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || null)
    .nullable()
const gateName = z.string().trim().min(1).max(64)
const gateUse = z.enum(['VISITORS_AND_RESIDENTS', 'VISITORS_ONLY', 'RESIDENTS_ONLY', 'SERVICE_AND_DELIVERY'])
const flatType = z.enum(['STUDIO', 'ONE_BHK', 'TWO_BHK', 'THREE_BHK', 'FOUR_BHK', 'PENTHOUSE', 'SHOP']).nullable()
/** Carpet area in square feet; a flat is never zero and never a palace */
const carpetAreaSqft = z.number().int().min(1).max(100000).nullable()
/** Slot labels as the society writes them, e.g. "P-12, P-13". The count is derived by the database. */
const parkingSlots = optionalText(64)

// Strict objects: society, block and floor ids come from the path and the hierarchy, never the body
export const updateSocietySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(160).optional(),
    address: optionalText(500).optional(),
    registrationNumber: optionalText(64).optional(),
    /** Validated against the standard 15-character GSTIN shape; the database holds the same rule */
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15-character GSTIN')
      .nullable()
      .optional(),
    pinCode: z.string().trim().regex(/^[1-9]\d{5}$/, 'Enter a 6-digit PIN code').nullable().optional(),
    city: optionalText(80).optional(),
    state: optionalText(80).optional(),
    officePhone: optionalText(15).optional(),
  })
  .refine(atLeastOneField, noFields)

export const createGateSchema = z.strictObject({ name: gateName, usedFor: gateUse.optional() })
export const updateGateSchema = z
  .strictObject({
    name: gateName.optional(),
    usedFor: gateUse.optional(),
    status: status.optional(),
    reason: reason.optional(),
  })
  .refine(atLeastOneField, noFields)
  .refine(reasonGiven, reasonRequired)

export const createBlockSchema = z.strictObject({ name: blockName })
export const updateBlockSchema = z
  .strictObject({ name: blockName.optional(), status: status.optional(), reason: reason.optional() })
  .refine(atLeastOneField, noFields)
  .refine(reasonGiven, reasonRequired)

export const createFloorSchema = z.strictObject({ floorLabel, sortOrder: sortOrder.optional() })
export const updateFloorSchema = z
  .strictObject({
    floorLabel: floorLabel.optional(),
    sortOrder: sortOrder.optional(),
    status: status.optional(),
    reason: reason.optional(),
  })
  .refine(atLeastOneField, noFields)
  .refine(reasonGiven, reasonRequired)

export const createFlatSchema = z
  .strictObject({
    number: flatNumber,
    sharingAllowed: z.boolean().optional(),
    maxOccupants: maxOccupants.optional(),
    flatType: flatType.optional(),
    carpetAreaSqft: carpetAreaSqft.optional(),
    parkingSlots: parkingSlots.optional(),
    intercom: optionalText(20).optional(),
  })
  .refine((body) => body.maxOccupants == null || body.sharingAllowed === true, {
    message: 'maxOccupants needs sharingAllowed: true',
  })
export const updateFlatSchema = z
  .strictObject({
    number: flatNumber.optional(),
    /** Moves the flat; its block and society follow the new floor */
    floorId: z.uuid().optional(),
    status: status.optional(),
    sharingAllowed: z.boolean().optional(),
    maxOccupants: maxOccupants.optional(),
    flatType: flatType.optional(),
    carpetAreaSqft: carpetAreaSqft.optional(),
    parkingSlots: parkingSlots.optional(),
    intercom: optionalText(20).optional(),
    reason: reason.optional(),
  })
  .refine(atLeastOneField, noFields)
  .refine(reasonGiven, reasonRequired)

export type UpdateSocietyBody = z.infer<typeof updateSocietySchema>
export type CreateBlockBody = z.infer<typeof createBlockSchema>
export type UpdateBlockBody = z.infer<typeof updateBlockSchema>
export type CreateFloorBody = z.infer<typeof createFloorSchema>
export type UpdateFloorBody = z.infer<typeof updateFloorSchema>
export type CreateGateBody = z.infer<typeof createGateSchema>
export type UpdateGateBody = z.infer<typeof updateGateSchema>
export type CreateFlatBody = z.infer<typeof createFlatSchema>
export type UpdateFlatBody = z.infer<typeof updateFlatSchema>
