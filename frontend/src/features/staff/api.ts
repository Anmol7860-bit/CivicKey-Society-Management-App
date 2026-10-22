import { call, type Gender, type IdDocumentType, type Status } from '../society/api'

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
  flatsServed: FlatServed[]
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
}

export function listStaff(token: string, societyId: string, filters: StaffFilters = {}) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString()
  return call<Staff[]>(token, 'GET', `/societies/${societyId}/staff${query ? `?${query}` : ''}`)
}
export const createStaff = (token: string, societyId: string, body: StaffBody & { kind: StaffKind; name: string; phone: string }) =>
  call<Staff>(token, 'POST', `/societies/${societyId}/staff`, body)
export const updateStaff = (token: string, id: string, body: StaffBody) => call<Staff>(token, 'PUT', `/staff/${id}`, body)
/** Issues a fresh pass code; the old one stops working at once */
export const reissuePass = (token: string, id: string) => call<Staff>(token, 'POST', `/staff/${id}/pass`)
