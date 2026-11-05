import { z } from 'zod'
import { groupMemberRole, groupScope } from '../../db/schema.js'

export const createGroupSchema = z
  .strictObject({
    name: z.string().trim().min(3, 'Give the group a name').max(80),
    purpose: z.string().trim().max(300).optional(),
    scope: z.enum(groupScope.enumValues).default('CUSTOM'),
    /** Only a block group names a block; the other two scopes are the whole society or hand-picked */
    blockId: z.uuid().optional(),
  })
  .refine((body) => (body.scope === 'BLOCK') === Boolean(body.blockId), {
    message: 'A block group names its block, and only a block group does',
    path: ['blockId'],
  })

/** Archiving follows the society's rule for taking a record out of use: say why. */
export const archiveGroupSchema = z.strictObject({
  reason: z.string().trim().min(3, 'Say why the group is being archived').max(300),
})

export const addMemberSchema = z.strictObject({
  userId: z.uuid(),
  role: z.enum(groupMemberRole.enumValues).default('MEMBER'),
})

export const listGroupsSchema = z.strictObject({
  scope: z.enum(groupScope.enumValues).optional(),
  /** Archived groups are out of the way unless asked for */
  archived: z.enum(['true']).optional(),
})

export type CreateGroupBody = z.infer<typeof createGroupSchema>
export type ArchiveGroupBody = z.infer<typeof archiveGroupSchema>
export type AddMemberBody = z.infer<typeof addMemberSchema>
export type ListGroupsQuery = z.infer<typeof listGroupsSchema>
