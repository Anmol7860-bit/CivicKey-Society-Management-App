import { call, type Gender, type IdDocumentType, type LoginCode, type Status } from '../society/api'

export type StaffKind = 'GUARD' | 'DAILY_HELP' | 'VENDOR'
export type StaffShift = 'MORNING' | 'EVENING' | 'NIGHT' | 'FULL_DAY'
export type PoliceVerification = 'NOT_STARTED' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED'
export type WorkingDay = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN'

export interface FlatServed {
  flatId: string
  /** Present on a staff member read back from the API */
  number?: string
  blockName?: string
  timeWindow?: string | null
}

/** The application account a guard signs in with. Daily help and vendors never have one. */
export interface StaffAccount {
  id: string
  name: string
  isActive: boolean
}

/** One stretch of time a guard was posted to a gate; the open one has no `endAt`. */
export interface Posting {
  id: string
  gateId: string
  gateName: string
  startAt: string
  endAt: string | null
}

export interface Staff {
  id: string
  societyId: string
  kind: StaffKind
  name: string
  phone: string
  workType: string | null
  agency: string | null
  gateId: string | null
  gateName: string | null
  shift: StaffShift | null
  policeVerification: PoliceVerification
  gender: Gender | null
  homeAddress: string | null
  /** Stored in week order, as 'MON,TUE,WED' */
  workingDays: string | null
  idDocumentType: IdDocumentType | null
  idDocumentLast4: string | null
  idDocumentOnFile: boolean
  photoReference: string | null
  /** What the guard reads at the gate */
  passCode: string
  passValidFrom: string
  passValidUntil: string | null
  status: Status
  account: StaffAccount | null
  flatsServed: FlatServed[]
}

export interface StaffDetail extends Staff {
  postings: Posting[]
}

export interface StaffBody {
  kind?: StaffKind
  name?: string
  phone?: string
  workType?: string
  agency?: string
  gateId?: string | null
  shift?: StaffShift | null
  policeVerification?: PoliceVerification
  gender?: Gender
  homeAddress?: string
  workingDays?: WorkingDay[]
  idDocumentType?: IdDocumentType
  idDocumentLast4?: string
  photoReference?: string
  passValidFrom?: string
  passValidUntil?: string | null
  flatsServed?: { flatId: string; timeWindow?: string }[]
  status?: Status
  reason?: string
}

export interface StaffFilters {
  kind?: StaffKind
  search?: string
  shift?: StaffShift
  status?: Status
  limit?: number
  offset?: number
}

/** One page of the society's staff, with the total behind it so the page count is known. */
export function listStaff(token: string, societyId: string, filters: StaffFilters = {}) {
  const query = new URLSearchParams(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => [key, String(value)]),
  ).toString()
  return call<{ total: number; staff: Staff[] }>(token, 'GET', `/societies/${societyId}/staff${query ? `?${query}` : ''}`)
}
/** One profile in full: the account behind it and every gate it has been posted to. */
export const getStaff = (token: string, id: string) => call<StaffDetail>(token, 'GET', `/staff/${id}`)
/**
 * Gives a guard the account they sign in with. A brand-new account comes back with the one-time
 * code the office hands over; an account that already existed keeps its own password.
 */
export const linkAccount = (token: string, id: string) =>
  call<Staff & { account: StaffAccount; loginCode: LoginCode | null }>(token, 'POST', `/staff/${id}/account`)
export const createStaff = (token: string, societyId: string, body: StaffBody & { kind: StaffKind; name: string; phone: string }) =>
  call<Staff>(token, 'POST', `/societies/${societyId}/staff`, body)
export const updateStaff = (token: string, id: string, body: StaffBody) => call<Staff>(token, 'PUT', `/staff/${id}`, body)
/** Issues a fresh pass code; the old one stops working at once */
export const reissuePass = (token: string, id: string) => call<Staff>(token, 'POST', `/staff/${id}/pass`)

/**
 * Reads the captured ID number itself. It is a POST because the server writes an audit line
 * naming who read it and why; the reason is required.
 */
export const revealIdNumber = (token: string, staffId: string, reason: string) =>
  call<{ idDocumentType: IdDocumentType | null; idNumber: string }>(token, 'POST', `/staff/${staffId}/id-document`, { reason })
