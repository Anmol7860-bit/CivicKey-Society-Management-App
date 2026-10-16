import { z } from 'zod'

const atLeastOneField = (body: object) => Object.keys(body).length > 0
const noFields = { message: 'Provide at least one field to update' }

const blockName = z.string().trim().min(1).max(64)
/** Free text, never parsed as a number: B2, Ground, 1st Floor, Terrace */
const floorLabel = z
  .string()
  .transform((label) => label.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'Floor label is required').max(40))
/** Negative values let basements sort first */
const displayOrder = z.number().int().min(-1000).max(1000).nullable()
const flatNumber = z.string().trim().min(1).max(16)

// Strict objects: society, block and floor ids come from the path and the hierarchy, never the body
export const updateSocietySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(160).optional(),
    address: z
      .string()
      .trim()
      .max(500)
      .transform((address) => address || null)
      .nullable()
      .optional(),
  })
  .refine(atLeastOneField, noFields)

export const createBlockSchema = z.strictObject({ name: blockName })
export const updateBlockSchema = z
  .strictObject({ name: blockName.optional(), isActive: z.boolean().optional() })
  .refine(atLeastOneField, noFields)

export const createFloorSchema = z.strictObject({ label: floorLabel, displayOrder: displayOrder.optional() })
export const updateFloorSchema = z
  .strictObject({ label: floorLabel.optional(), displayOrder: displayOrder.optional(), isActive: z.boolean().optional() })
  .refine(atLeastOneField, noFields)

export const createFlatSchema = z.strictObject({ number: flatNumber })
export const updateFlatSchema = z
  .strictObject({
    number: flatNumber.optional(),
    /** Moves the flat; its block and society follow the new floor */
    floorId: z.uuid().optional(),
    isActive: z.boolean().optional(),
  })
  .refine(atLeastOneField, noFields)

export type UpdateSocietyBody = z.infer<typeof updateSocietySchema>
export type CreateBlockBody = z.infer<typeof createBlockSchema>
export type UpdateBlockBody = z.infer<typeof updateBlockSchema>
export type CreateFloorBody = z.infer<typeof createFloorSchema>
export type UpdateFloorBody = z.infer<typeof updateFloorSchema>
export type CreateFlatBody = z.infer<typeof createFlatSchema>
export type UpdateFlatBody = z.infer<typeof updateFlatSchema>
