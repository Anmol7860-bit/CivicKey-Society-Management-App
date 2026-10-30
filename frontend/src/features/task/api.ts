import { call } from '../society/api'
import type { StaffKind } from '../staff/api'

export type TaskCategory = 'PLUMBING' | 'ELECTRICAL' | 'HOUSEKEEPING' | 'SECURITY' | 'LIFT' | 'PARKING' | 'GARDEN' | 'OTHER'
export type TaskPriority = 'LOW' | 'NORMAL' | 'HIGH'
export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED'

export interface Task {
  id: string
  societyId: string
  title: string
  details: string | null
  category: TaskCategory
  priority: TaskPriority
  status: TaskStatus
  location: string | null
  dueDate: string | null
  assignedStaffId: string | null
  closedAt: string | null
  closingNote: string | null
  createdAt: string
  updatedAt: string
  /** The staff member or vendor the work was handed to */
  assignee: { id: string; name: string; kind: StaffKind; phone: string; workType: string | null } | null
  raisedByName: string | null
  /** Still open and past its due date */
  overdue: boolean
}

export interface TaskSummary {
  open: number
  inProgress: number
  overdue: number
  unassigned: number
  doneThisMonth: number
}

export interface TaskBody {
  title: string
  details?: string
  category?: TaskCategory
  priority?: TaskPriority
  location?: string
  dueDate?: string | null
  assignedStaffId?: string | null
}

export interface TaskFilters {
  status?: TaskStatus
  category?: TaskCategory
  assignedStaffId?: string
  search?: string
  overdue?: 'true'
  /** When the task was raised */
  from?: string
  to?: string
  page?: number
  limit?: number
}

/** One thing that happened to a task, read from the audit rows written with each change. */
export interface TaskEvent {
  id: string
  eventType: 'TASK_CREATED' | 'TASK_UPDATED' | 'TASK_STATUS_CHANGED'
  actorName: string | null
  at: string
  detail: { from?: TaskStatus; to?: TaskStatus; note?: string; fields?: string[]; assignedFrom?: string | null; assignedTo?: string | null }
}

export function listTasks(token: string, societyId: string, filters: TaskFilters = {}) {
  const query = new URLSearchParams(
    Object.entries(filters)
      .filter(([, value]) => value)
      .map(([key, value]) => [key, String(value)]),
  ).toString()
  return call<Task[]>(token, 'GET', `/societies/${societyId}/tasks${query ? `?${query}` : ''}`)
}
export const taskSummary = (token: string, societyId: string) => call<TaskSummary>(token, 'GET', `/societies/${societyId}/task-summary`)
export const createTask = (token: string, societyId: string, body: TaskBody) =>
  call<Task>(token, 'POST', `/societies/${societyId}/tasks`, body)
export const updateTask = (token: string, id: string, body: Partial<TaskBody>) => call<Task>(token, 'PUT', `/tasks/${id}`, body)
export const setTaskStatus = (token: string, id: string, body: { status: TaskStatus; note?: string }) =>
  call<Task>(token, 'POST', `/tasks/${id}/status`, body)
export const getTask = (token: string, id: string) => call<Task>(token, 'GET', `/tasks/${id}`)
export const taskHistory = (token: string, id: string) => call<TaskEvent[]>(token, 'GET', `/tasks/${id}/history`)
