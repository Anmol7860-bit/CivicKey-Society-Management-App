import { z } from 'zod'
import { flatAccess, idDocumentType, residentType, verificationStatus } from '../../db/schema.js'

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
const accessLevel = z.enum(flatAccess.enumValues)

export const registerResidentSchema = z
  .strictObject({
    name: z.string().trim().min(2, 'Name is required').max(120),
    phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Phone must be a 10-digit Indian mobile number'),
    email: z.email('Email must be a valid email address').trim().toLowerCase().max(254).optional(),
    residentType: z.enum(residentType.enumValues),
    /** VIEW_ONLY lets the person see the flat without approving visitors or paying */
    accessLevel: accessLevel.optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    idDocumentType: z.enum(idDocumentType.enumValues).optional(),
    /**
     * The full ID number, kept only as a keyed hash plus its last 4 digits. Send `idDocumentLast4`
     * instead when the number itself must not leave the Admin's hands.
     */
    idNumber: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[0-9A-Z]{6,20}$/, 'The ID number must be 6 to 20 letters or digits')
      .optional(),
    idDocumentLast4: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[0-9A-Z]{4}$/, 'Send only the last 4 characters of the document number')
      .optional(),
    /** Sale deed, rent agreement or other proof reference */
    proofReference: z.string().trim().min(1).max(200).optional(),
  })
  .refine((body) => body.residentType !== 'TENANT' || body.endDate !== undefined, {
    message: 'A tenancy must have an end date',
    path: ['endDate'],
  })
  .refine((body) => body.residentType !== 'TENANT' || body.startDate !== undefined, {
    message: 'A tenancy must have a start date',
    path: ['startDate'],
  })
  .refine((body) => !body.endDate || !body.startDate || body.endDate >= body.startDate, {
    message: 'The end date cannot be before the start date',
    path: ['endDate'],
  })
  .refine((body) => (body.idDocumentLast4 ?? body.idNumber) === undefined || body.idDocumentType !== undefined, {
    message: 'Give the document type as well',
    path: ['idDocumentType'],
  })
  .refine((body) => !body.idNumber || !body.idDocumentLast4 || body.idNumber.endsWith(body.idDocumentLast4), {
    message: 'The last 4 characters do not match the ID number',
    path: ['idDocumentLast4'],
  })

export const verifyResidentSchema = z.strictObject({ accessLevel: accessLevel.optional() })

export const rejectResidentSchema = z.strictObject({ reason: z.string().trim().min(3, 'Give a reason').max(200) })

export const updateResidentSchema = z
  .strictObject({
    endDate: isoDate.nullable().optional(),
    accessLevel: accessLevel.optional(),
    /** Required when the change closes the assignment; kept in the audit trail with the actor */
    reason: z.string().trim().min(3, 'Give a reason').max(200).optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'reason'), { message: 'Provide at least one field to update' })

/** Filters for the Admin's resident directory; `active` means verified and inside its period. */
export const listResidentsSchema = z.strictObject({
  status: z.enum(verificationStatus.enumValues).optional(),
  residentType: z.enum(residentType.enumValues).optional(),
  active: z.enum(['true', 'false']).optional(),
})

export type ListResidentsQuery = z.infer<typeof listResidentsSchema>
export type RegisterResidentBody = z.infer<typeof registerResidentSchema>
export type VerifyResidentBody = z.infer<typeof verifyResidentSchema>
export type RejectResidentBody = z.infer<typeof rejectResidentSchema>
export type UpdateResidentBody = z.infer<typeof updateResidentSchema>
