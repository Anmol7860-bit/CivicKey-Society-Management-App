import { z } from 'zod'
import { taskCategory, taskPriority, taskStatus } from '../../db/schema.js'

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')

const fields = {
  title: z.string().trim().min(3, 'Say what needs doing').max(120),
  details: z.string().trim().max(2000).optional(),
  category: z.enum(taskCategory.enumValues).optional(),
  priority: z.enum(taskPriority.enumValues).optional(),
  location: z.string().trim().max(120).optional(),
  dueDate: isoDate.nullable().optional(),
  assignedStaffId: z.uuid().nullable().optional(),
}

export const createTaskSchema = z.strictObject(fields)

/** Every field optional, but a request that changes nothing is a mistake worth reporting. */
export const updateTaskSchema = z
  .strictObject({ ...fields, title: fields.title.optional() })
  .refine((body) => Object.keys(body).length > 0, 'Change at least one field')

export const taskStatusSchema = z
  .strictObject({
    status: z.enum(taskStatus.enumValues),
    /** Why it was closed or cancelled; kept with the task rather than only in the audit log */
    note: z.string().trim().max(300).optional(),
  })
  .refine((body) => body.status !== 'CANCELLED' || Boolean(body.note), {
    message: 'Say why the task is being cancelled',
    path: ['note'],
  })

export const listTasksSchema = z
  .strictObject({
    status: z.enum(taskStatus.enumValues).optional(),
    category: z.enum(taskCategory.enumValues).optional(),
    assignedStaffId: z.uuid().optional(),
    /** Matches the title, details or location */
    search: z.string().trim().min(1).max(60).optional(),
    /** Open tasks whose due date has passed */
    overdue: z.enum(['true']).optional(),
    /** When the task was raised, not when it is due: the work list is read by the day it arrived */
    from: isoDate.optional(),
    to: isoDate.optional(),
    page: z.coerce.number().int().min(1).default(1),
    // The work list has no pager yet, so the default stays the bound the list already had
    limit: z.coerce.number().int().min(1).max(200).default(200),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: 'The end of the range comes before its start',
    path: ['to'],
  })

export type CreateTaskBody = z.infer<typeof createTaskSchema>
export type UpdateTaskBody = z.infer<typeof updateTaskSchema>
export type TaskStatusBody = z.infer<typeof taskStatusSchema>
export type ListTasksQuery = z.infer<typeof listTasksSchema>
