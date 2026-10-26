import { call } from '../society/api'

export type NotificationEvent =
  | 'VISITOR_WAITING_APPROVAL'
  | 'VISITOR_APPROVAL_REMINDER'
  | 'VISITOR_ESCALATED_TO_GATE'
  | 'VISITOR_DECIDED'
  | 'VISITOR_ENTERED'
  | 'VISITOR_EXITED'
  | 'STAFF_ENTERED'
  | 'STAFF_EXITED'
  | 'OFFLINE_EVENT_NEEDS_REVIEW'
  | 'INVOICE_GENERATED'
  | 'BILL_DUE_SOON'
  | 'BILL_OVERDUE'
  | 'PAYMENT_RECORDED'
  | 'RECEIPT_READY'
  | 'TASK_ASSIGNED'
  | 'TASK_DUE_SOON'
  | 'TASK_OVERDUE'
  | 'TASK_STATUS_CHANGED'

export interface Notification {
  id: string
  eventType: NotificationEvent
  entityType: string
  entityId: string | null
  title: string
  body: string
  readAt: string | null
  createdAt: string
}

export const listNotifications = (token: string) =>
  call<{ items: Notification[]; unread: number }>(token, 'GET', '/notifications')

export const markAllRead = (token: string) => call<{ marked: number }>(token, 'POST', '/notifications/read', {})
export const markRead = (token: string, id: string) => call<{ marked: number }>(token, 'POST', `/notifications/${id}/read`, {})

export const getPushKey = (token: string) => call<{ publicKey: string | null }>(token, 'GET', '/notifications/push-key')

export interface PushSubscriptionBody {
  endpoint: string
  keys: { p256dh: string; auth: string }
}
export const savePushSubscription = (token: string, body: PushSubscriptionBody) =>
  call<{ id: string }>(token, 'POST', '/notifications/push', body)
