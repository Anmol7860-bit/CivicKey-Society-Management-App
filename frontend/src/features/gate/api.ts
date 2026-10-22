import { call, type Gender, type IdDocumentType, type Status } from '../society/api'
import type { Staff } from '../staff/api'

export type VisitPurpose = 'GUEST' | 'DELIVERY' | 'CAB' | 'SERVICE' | 'OTHER'
export type VisitStatus = 'WAITING' | 'APPROVED' | 'LEAVE_AT_GATE' | 'DENIED' | 'INSIDE' | 'LEFT'
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
  passCode: string | null
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

export interface DailyHelp extends Omit<Staff, 'flatsServed'> {
  timeWindow: string | null
  inside: boolean
  enteredAt: string | null
  onLeaveToday: boolean
  lastSeen: { enteredAt: string; exitedAt: string | null } | null
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
  /** First names only, which is all the gate is told about who lives there */
  residents: string[]
}

// --- The guard's screens ----------------------------------------------------
export const flatDirectory = (token: string, societyId: string) => call<FlatOption[]>(token, 'GET', `/societies/${societyId}/flat-directory`)
export const gateSummary = (token: string, societyId: string) => call<GateSummary>(token, 'GET', `/societies/${societyId}/gate-summary`)

export function listVisits(token: string, societyId: string, filters: { status?: VisitStatus; gateId?: string; search?: string } = {}) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString()
  return call<Visit[]>(token, 'GET', `/societies/${societyId}/visits${query ? `?${query}` : ''}`)
}
export const registerVisit = (token: string, societyId: string, body: RegisterVisitBody) =>
  call<Visit>(token, 'POST', `/societies/${societyId}/visits`, body)
export const lookupVisitor = (token: string, societyId: string, phone: string) =>
  call<VisitorLookup | null>(token, 'GET', `/societies/${societyId}/visitor-lookup?phone=${encodeURIComponent(phone)}`)
export const listInside = (token: string, societyId: string) => call<InsideRow[]>(token, 'GET', `/societies/${societyId}/inside`)
export const validatePass = (token: string, societyId: string, code: string) =>
  call<PassCheck>(token, 'GET', `/societies/${societyId}/passes/validate?code=${encodeURIComponent(code)}`)
export const checkStaffPass = (token: string, societyId: string, passCode: string) =>
  call<StaffCheck>(token, 'GET', `/societies/${societyId}/staff-pass/${encodeURIComponent(passCode)}`)

export const recordEntry = (token: string, visitId: string, gateId?: string) =>
  call<Visit>(token, 'POST', `/visits/${visitId}/entry`, gateId ? { gateId } : {})
export const recordExit = (token: string, visitId: string) => call<Visit>(token, 'POST', `/visits/${visitId}/exit`, {})
export const recordStaffEntry = (token: string, staffId: string, gateId?: string) =>
  call<{ id: string }>(token, 'POST', `/staff/${staffId}/entry`, gateId ? { gateId } : {})
export const recordStaffExit = (token: string, staffId: string) => call<{ id: string }>(token, 'POST', `/staff/${staffId}/exit`, {})

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
