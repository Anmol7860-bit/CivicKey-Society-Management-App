import { z } from 'zod'
import { flatAccess, gender, residentType, verificationStatus } from '../../db/schema.js'
import { identityRefinements, identitySchema } from '../access/identity.js'

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
const accessLevel = z.enum(flatAccess.enumValues)
const mobile = z.string().trim().regex(/^[6-9]\d{9}$/, 'Phone must be a 10-digit Indian mobile number')
/** The locales the society can address someone in; the check constraint holds the same list. */
const preferredLanguage = z.enum(['en', 'hi', 'mr'])

export const registerResidentSchema = identityRefinements(
  z
    .strictObject({
      name: z.string().trim().min(2, 'Name is required').max(120),
      phone: mobile,
      email: z.email('Email must be a valid email address').trim().toLowerCase().max(254).optional(),
      /** Profile details; all optional, and only written when the account is new or has none */
      dateOfBirth: isoDate.optional(),
      gender: z.enum(gender.enumValues).optional(),
      preferredLanguage: preferredLanguage.optional(),
      alternatePhone: mobile.optional(),
      emergencyContactName: z.string().trim().min(2).max(120).optional(),
      emergencyContactRelationship: z.string().trim().min(2).max(60).optional(),
      emergencyContactPhone: mobile.optional(),
      /** How this person relates to the flat: Self, Spouse, Son, Parent */
      relationship: z.string().trim().min(2).max(60).optional(),
      residentType: z.enum(residentType.enumValues),
      /** VIEW_ONLY lets the person see the flat without approving visitors or paying */
      accessLevel: accessLevel.optional(),
      startDate: isoDate.optional(),
      endDate: isoDate.optional(),
      ...identitySchema,
      /** Sale deed, rent agreement or other proof reference */
      proofReference: z.string().trim().min(1).max(200).optional(),
    })
    .refine((body) => body.dateOfBirth === undefined || body.dateOfBirth < new Date().toISOString().slice(0, 10), {
      message: 'The date of birth must be in the past',
      path: ['dateOfBirth'],
    })
    .refine((body) => body.alternatePhone === undefined || body.alternatePhone !== body.phone, {
      message: 'The alternate number must differ from the sign-in number',
      path: ['alternatePhone'],
    })
    .refine((body) => body.emergencyContactPhone === undefined || body.emergencyContactPhone !== body.phone, {
      message: 'Nobody can be their own emergency contact',
      path: ['emergencyContactPhone'],
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
    }),
)

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
  /** Matches a resident name or mobile, a flat number, a block-flat label like A-101, or a flat id */
  search: z.string().trim().min(1).max(60).optional(),
  status: z.enum(verificationStatus.enumValues).optional(),
  residentType: z.enum(residentType.enumValues).optional(),
  active: z.enum(['true', 'false']).optional(),
})

export type ListResidentsQuery = z.infer<typeof listResidentsSchema>
export type RegisterResidentBody = z.infer<typeof registerResidentSchema>
export type VerifyResidentBody = z.infer<typeof verifyResidentSchema>
export type RejectResidentBody = z.infer<typeof rejectResidentSchema>
export type UpdateResidentBody = z.infer<typeof updateResidentSchema>
