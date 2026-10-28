import { ApiError, QueuedOfflineError } from '../auth/api'
import { call, type Gender, type IdDocumentType, type Status } from '../society/api'
import { enqueue, type OperationType } from '../sync/queue'
import type { PoliceVerification, Staff, StaffKind } from '../staff/api'

export type VisitPurpose =
  | 'GUEST'
  | 'FOOD_DELIVERY'
  | 'DELIVERY'
  | 'CAB'
  | 'DOMESTIC_HELP'
  | 'MAINTENANCE'
  | 'SERVICE'
  | 'BUSINESS'
  | 'OTHER'
/** AWAITING_MANUAL is a visit nobody answered: the guard decides at the gate. */
export type VisitStatus = 'AWAITING_APPROVAL' | 'AWAITING_MANUAL' | 'APPROVED' | 'LEAVE_AT_GATE' | 'DENIED' | 'ENTERED' | 'CLOSED'
export type PassType = 'ONE_ENTRY' | 'MULTI_ENTRY'
export type PassStatus = 'ACTIVE' | 'USED' | 'CANCELLED'
export type VehicleType = 'CAR' | 'BIKE' | 'SCOOTER' | 'BICYCLE' | 'OTHER'
export type AccessRequestKind = 'HOUSEHOLD_MEMBER' | 'DAILY_HELP'
export type AccessRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

export interface FlatLabel {
  number: string
  blockName: string
  floorLabel: string
  label: string
}

export interface Visit {
  id: string
  societyId: string
  gateId: string | null
  flatId: string
  passId: string | null
  visitorName: string
  visitorPhone: string
  purpose: VisitPurpose
  company: string | null
  people: number
  vehicleNumber: string | null
  note: string | null
  photoReference: string | null
  status: VisitStatus
  decidedAt: string | null
  decisionReason: string | null
  enteredAt: string | null
  exitedAt: string | null
  createdAt: string
  flat: FlatLabel
  gateName: string | null
  /** The guard who registered the visit, shown beside the gate */
  registeredByName: string | null
  passCode: string | null
  intendedResidentId?: string | null
  expectedAt?: string
  /** On registration only, and only when nobody in the flat can approve: who the guard may ring */
  contact?: { name: string; phone: string } | null
}

export interface VisitorPass {
  id: string
  flatId: string
  visitorName: string
  visitorPhone: string
  purpose: VisitPurpose
  people: number
  validOn: string
  validFrom: string
  validUntil: string
  vehicleNumber: string | null
  passType: PassType
  note: string | null
  entryCode: string
  status: PassStatus
  usedAt: string | null
  createdAt: string
  flat?: FlatLabel
}

export interface PassCheck {
  valid: boolean
  reason: string | null
  pass: VisitorPass | null
}

export interface StaffCheck {
  valid: boolean
  reason: string | null
  staff:
    | (Omit<Staff, 'flatsServed'> & {
        flatsServed: { flatId: string; number: string; blockName: string; label: string; timeWindow: string | null }[]
        inside: boolean
        enteredAt: string | null
      })
    | null
}

export interface InsideRow {
  id: string
  kind: 'VISITOR' | 'STAFF'
  name: string
  type: string
  flat: string
  enteredAt: string | null
  vehicleNumber: string | null
  gateName: string | null
}

export interface GateSummary {
  waiting: number
  inside: number
  visitorsInside: number
  staffInside: number
  today: number
  expected: number
}

export interface VisitorLookup {
  visitorName: string
  visitorPhone: string
  purpose: VisitPurpose
  company: string | null
  vehicleNumber: string | null
  photoReference: string | null
  lastVisit: { at: string; flat: string }
}

export interface RegisterVisitBody {
  flatId: string
  gateId?: string
  visitorName: string
  visitorPhone: string
  purpose: VisitPurpose
  company?: string
  people?: number
  vehicleNumber?: string
  note?: string
  photoReference?: string
  intendedResidentId?: string
  expectedDate?: string
  expectedTime?: string
  clientEventId?: string
  entryCode?: string
}

export interface CreatePassBody {
  visitorName: string
  visitorPhone: string
  purpose: VisitPurpose
  people?: number
  validOn: string
  validFrom: string
  validUntil: string
  vehicleNumber?: string
  passType?: PassType
  note?: string
}

/** A resident's view of their daily help: never the login account behind a society's staff */
export interface DailyHelp extends Omit<Staff, 'flatsServed' | 'account'> {
  timeWindow: string | null
  inside: boolean
  enteredAt: string | null
  onLeaveToday: boolean
  lastSeen: { enteredAt: string; exitedAt: string | null } | null
}

export type StaffRejectionReason =
  | 'STAFF_INACTIVE'
  | 'NOT_REGISTERED'
  | 'WRONG_SOCIETY'
  | 'VERIFICATION_FAILED'
  | 'INVALID_PASS'
  | 'ALREADY_INSIDE'
  | 'SECURITY_CONCERN'
  | 'OTHER'

/** What the gate is told about a staff member before anything is recorded */
export interface StaffVerification {
  staffId: string
  name: string
  phone: string
  staffType: string
  kind: StaffKind
  photoReference: string | null
  policeVerification: PoliceVerification
  active: boolean
  passCode: string
  passValidUntil: string | null
  currentlyInside: boolean
  movementState: 'ENTERED' | 'NOT_INSIDE'
  enteredAt: string | null
  flatsServed: { flatId: string; label: string; timeWindow?: string | null }[]
  /** Why entry cannot be recorded, or null when it can */
  blockedReason: StaffRejectionReason | null
}

export interface StaffInsideRow {
  staffId: string
  name: string
  staffType: string
  kind: StaffKind
  enteredAt: string
  gateName: string | null
  flats: string[]
}

export interface StaffMovement {
  id: string
  staffId: string
  name: string
  staffType: string
  kind: StaffKind
  eventType: 'ENTRY' | 'EXIT' | 'ENTRY_REJECTED'
  verificationStatus: 'VERIFIED' | 'REJECTED'
  at: string
  gateName: string | null
  performedBy: string | null
  rejectionReason: StaffRejectionReason | null
  rejectionNote: string | null
}

export interface StaffMovementFilters {
  staffId?: string
  staffType?: string
  gateId?: string
  dateFrom?: string
  dateTo?: string
  eventType?: 'ENTRY' | 'EXIT' | 'ENTRY_REJECTED'
  verificationStatus?: 'VERIFIED' | 'REJECTED'
  limit?: number
  offset?: number
}

export interface Movement {
  id: string
  kind: 'VISITOR' | 'STAFF'
  direction: 'IN' | 'OUT'
  at: string
  name: string
  /** The visit's purpose, or the staff member's kind */
  type: string
  flat: string
  gateName: string | null
  vehicleNumber: string | null
}

export interface GateLog {
  /** The day the log covers, as YYYY-MM-DD */
  on: string
  metrics: {
    entries: number
    exits: number
    stillInside: number
    openOvernight: number
    turnedAway: number
    averageStayMinutes: number | null
    busiestHour: { hour: number; entries: number } | null
    byType: Record<string, number>
  }
  movements: Movement[]
}

export interface Attendance {
  attendance: { id: string; staffId: string; enteredAt: string; exitedAt: string | null }[]
  leave: { staffId: string; onDate: string }[]
}

export interface Vehicle {
  id: string
  flatId: string
  number: string
  vehicleType: VehicleType
  makeColour: string | null
  status: Status
  createdAt: string
}

export interface AccessRequest {
  id: string
  flatId: string
  kind: AccessRequestKind
  name: string
  phone: string
  relationship: string | null
  accessLevel: 'FULL' | 'VIEW_ONLY' | null
  timings: string | null
  status: AccessRequestStatus
  decidedAt: string | null
  decisionReason: string | null
  createdAt: string
  flat?: FlatLabel
}

export interface AccessRequestBody {
  flatId: string
  kind: AccessRequestKind
  name: string
  phone: string
  relationship?: string
  accessLevel?: 'FULL' | 'VIEW_ONLY'
  timings?: string
}

export interface FlatOption {
  id: string
  label: string
  /** Who lives there, so the guard can say which of them the visitor asked for */
  residents: { id: string; name: string }[]
}

// --- The guard's screens ----------------------------------------------------
export const flatDirectory = (token: string, societyId: string) => call<FlatOption[]>(token, 'GET', `/societies/${societyId}/flat-directory`)
/** The visitor types this society uses, in the order its form shows them */
export const visitPurposes = (token: string, societyId: string) =>
  call<VisitPurpose[]>(token, 'GET', `/societies/${societyId}/visit-purposes`)
export const gateSummary = (token: string, societyId: string) => call<GateSummary>(token, 'GET', `/societies/${societyId}/gate-summary`)

export function listVisits(token: string, societyId: string, filters: { status?: VisitStatus; gateId?: string; search?: string } = {}) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString()
  return call<Visit[]>(token, 'GET', `/societies/${societyId}/visits${query ? `?${query}` : ''}`)
}
/**
 * Runs a gate action, or saves it on this device when the server cannot be reached.
 *
 * An ApiError means the server answered and refused: that is a real failure and is passed on.
 * Anything else is an outage, so the action is queued with its own request id and uploaded on the
 * next sync, and the caller is told it was queued rather than done.
 */
async function queueable<T>(operation: OperationType, payload: Record<string, unknown>, entityId: string | null, live: () => Promise<T>) {
  try {
    return await live()
  } catch (error) {
    if (error instanceof ApiError) throw error
    await enqueue(operation, payload, entityId)
    throw new QueuedOfflineError()
  }
}

export const registerVisit = (token: string, societyId: string, body: RegisterVisitBody) =>
  queueable('VISITOR_REGISTER', { ...body }, null, () => call<Visit>(token, 'POST', `/societies/${societyId}/visits`, body))

/**
 * The guard let an unannounced visitor in while the gate was offline. Always queued: there is no
 * live call, because nobody could be asked. It reaches the office flagged for review.
 */
export const recordManualOfflineEntry = (body: RegisterVisitBody & { reason: string }) =>
  enqueue('MANUAL_OFFLINE_ENTRY', { ...body }, null)
export const lookupVisitor = (token: string, societyId: string, phone: string) =>
  call<VisitorLookup | null>(token, 'GET', `/societies/${societyId}/visitor-lookup?phone=${encodeURIComponent(phone)}`)
export const listInside = (token: string, societyId: string) => call<InsideRow[]>(token, 'GET', `/societies/${societyId}/inside`)
/** One day of movements, with the shift's numbers; omit `on` for today */
export const getGateLog = (token: string, societyId: string, on?: string) =>
  call<GateLog>(token, 'GET', `/societies/${societyId}/gate-log${on ? `?on=${on}` : ''}`)
export const validatePass = (token: string, societyId: string, code: string) =>
  call<PassCheck>(token, 'GET', `/societies/${societyId}/passes/validate?code=${encodeURIComponent(code)}`)
export const checkStaffPass = (token: string, societyId: string, passCode: string) =>
  call<StaffCheck>(token, 'GET', `/societies/${societyId}/staff-pass/${encodeURIComponent(passCode)}`)

export const recordEntry = (token: string, visitId: string, gateId?: string) =>
  queueable('VISIT_ENTRY_RECORD', gateId ? { gateId } : {}, visitId, () =>
    call<Visit>(token, 'POST', `/visits/${visitId}/entry`, gateId ? { gateId } : {}),
  )
export const recordExit = (token: string, visitId: string) =>
  queueable('VISIT_EXIT', {}, visitId, () => call<Visit>(token, 'POST', `/visits/${visitId}/exit`, {}))
/**
 * The request id for one tap. The same movement sent twice - a retry after a lost response, or a
 * double tap - is answered with the movement already recorded rather than a second one.
 */
interface StaffMovementBody {
  gateId?: string
  idempotencyKey?: string
}
export const recordStaffEntry = (token: string, staffId: string, body: StaffMovementBody = {}) =>
  call<{ id: string; enteredAt: string }>(token, 'POST', `/staff/${staffId}/entry`, body)
export const recordStaffExit = (token: string, staffId: string, body: StaffMovementBody = {}) =>
  call<{ id: string; exitedAt: string | null }>(token, 'POST', `/staff/${staffId}/exit`, body)
export const rejectStaffEntry = (
  token: string,
  staffId: string,
  body: StaffMovementBody & { reason: StaffRejectionReason; note?: string },
) => call<{ id: string }>(token, 'POST', `/staff/${staffId}/movement/entry-rejection`, body)

export const staffVerification = (token: string, staffId: string) =>
  call<StaffVerification>(token, 'GET', `/staff/${staffId}/verification`)
export const listStaffInside = (token: string, societyId: string) =>
  call<StaffInsideRow[]>(token, 'GET', `/societies/${societyId}/staff-inside`)
export function listStaffMovements(token: string, societyId: string, filters: StaffMovementFilters = {}) {
  const query = new URLSearchParams(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => [key, String(value)]),
  ).toString()
  return call<{ total: number; movements: StaffMovement[] }>(token, 'GET', `/societies/${societyId}/staff-movements${query ? `?${query}` : ''}`)
}

// --- The resident's screens -------------------------------------------------
export const listMyVisits = (token: string) => call<Visit[]>(token, 'GET', '/me/visits')
export const decideVisit = (token: string, visitId: string, body: { decision: 'APPROVED' | 'LEAVE_AT_GATE' | 'DENIED'; reason?: string }) =>
  call<Visit>(token, 'POST', `/visits/${visitId}/decision`, body)

export const listMyPasses = (token: string) => call<VisitorPass[]>(token, 'GET', '/me/passes')
export const createPass = (token: string, flatId: string, body: CreatePassBody) =>
  call<VisitorPass>(token, 'POST', `/flats/${flatId}/passes`, body)
export const cancelPass = (token: string, passId: string) => call<VisitorPass>(token, 'POST', `/passes/${passId}/cancel`, {})

export const listMyDailyHelp = (token: string) => call<DailyHelp[]>(token, 'GET', '/me/daily-help')
export const getAttendance = (token: string, staffId: string) => call<Attendance>(token, 'GET', `/staff/${staffId}/attendance`)
export const markLeave = (token: string, staffId: string) => call<{ staffId: string }>(token, 'POST', `/staff/${staffId}/leave`, {})

export const listMyVehicles = (token: string) => call<Vehicle[]>(token, 'GET', '/me/vehicles')
export const addVehicle = (token: string, flatId: string, body: { number: string; vehicleType?: VehicleType; makeColour?: string }) =>
  call<Vehicle>(token, 'POST', `/flats/${flatId}/vehicles`, body)
export const removeVehicle = (token: string, id: string) => call<Vehicle>(token, 'DELETE', `/vehicles/${id}`)

export const listMyAccessRequests = (token: string) => call<AccessRequest[]>(token, 'GET', '/me/access-requests')
export const createAccessRequest = (token: string, body: AccessRequestBody) => call<AccessRequest>(token, 'POST', '/me/access-requests', body)

export type { Gender, IdDocumentType }
