import { send } from '../auth/api'

export type Status = 'ACTIVE' | 'INACTIVE'
export type ResidentType = 'OWNER' | 'TENANT'
export type AccessLevel = 'FULL' | 'VIEW_ONLY'
export type VerificationStatus = 'PENDING' | 'VERIFIED' | 'REJECTED'
export type IdDocumentType = 'AADHAAR' | 'PAN' | 'PASSPORT' | 'DRIVING_LICENCE' | 'VOTER_ID'
export type Gender = 'MALE' | 'FEMALE' | 'OTHER' | 'PREFER_NOT_TO_SAY'
/** The locales the society can address someone in; the database holds the same list */
export type PreferredLanguage = 'en' | 'hi' | 'mr'

export type GateUse = 'VISITORS_AND_RESIDENTS' | 'VISITORS_ONLY' | 'RESIDENTS_ONLY' | 'SERVICE_AND_DELIVERY'
export type FlatType = 'STUDIO' | 'ONE_BHK' | 'TWO_BHK' | 'THREE_BHK' | 'FOUR_BHK' | 'PENTHOUSE' | 'SHOP'

export interface Society {
  id: string
  name: string
  address: string | null
  registrationNumber: string | null
  /** Only societies that charge GST on maintenance have one */
  gstin: string | null
  pinCode: string | null
  city: string | null
  state: string | null
  officePhone: string | null
}

export interface Gate {
  id: string
  societyId: string
  name: string
  usedFor: GateUse
  status: Status
}

export interface Block {
  id: string
  societyId: string
  name: string
  status: Status
}

export interface Floor {
  id: string
  blockId: string
  floorLabel: string
  sortOrder: number | null
  status: Status
}

export interface Flat {
  id: string
  blockId: string
  floorId: string
  number: string
  status: Status
  sharingAllowed: boolean
  maxOccupants: number | null
  /** What the flat is and how big: both feed the maintenance charge */
  flatType: FlatType | null
  carpetAreaSqft: number | null
  parkingSlots: string | null
  /** Counted by the database from the slot labels */
  parkingSlotCount: number
  intercom: string | null
}

/** The flat fields the add and edit forms send; the hierarchy is never in the body */
export interface FlatBody {
  number?: string
  sharingAllowed?: boolean
  maxOccupants?: number | null
  flatType?: FlatType | null
  carpetAreaSqft?: number | null
  parkingSlots?: string | null
  intercom?: string | null
}

/** A flat as the occupancy view reports it: what is sold, who lives there and how many may still join. */
export interface OccupancyFlat extends Flat {
  /** Owners first, so the flats table can name the owner and the tenant separately */
  residents: { name: string; residentType: ResidentType }[]
  owners: number
  tenants: number
  occupants: number
  slotsLeft: number | null
  ownership: 'UNSOLD' | 'OWNED'
  occupancy: 'VACANT' | 'SHARING' | 'FULL'
}

export interface Occupancy {
  society: { id: string; name: string }
  summary: {
    flats: number
    inactive: number
    unsold: number
    owned: number
    vacant: number
    occupied: number
    sharingAvailable: number
  }
  blocks: (Block & { floors: (Floor & { flats: OccupancyFlat[] })[] })[]
}

export interface Resident {
  id: string
  flatId: string
  userId: string
  residentType: ResidentType
  accessLevel: AccessLevel
  startDate: string
  endDate: string | null
  verificationStatus: VerificationStatus
  verifiedAt: string | null
  rejectedReason: string | null
  idDocumentType: IdDocumentType | null
  idDocumentLast4: string | null
  proofReference: string | null
  relationship: string | null
  idDocumentOnFile: boolean
  /** Whether the Admin set this person up to answer visitors for the flat */
  visitorApprovalEligible: boolean
  user: { id: string; name: string; phone: string | null; email: string | null }
  /** Verified and inside its dates */
  active: boolean
  /** Active and set up to answer visitors, so approvals route here */
  eligible: boolean
  flat?: { id: string; number: string; flatType?: FlatType | null; carpetAreaSqft?: number | null }
  floor?: { id: string; floorLabel: string }
  block?: { id: string; name: string }
}

/** One of the signed-in person's own assignments, with the household they may see. */
export interface MyAssignment extends Resident {
  flat: { id: string; number: string; sharingAllowed: boolean; maxOccupants: number | null }
  floor: { id: string; floorLabel: string }
  block: { id: string; name: string }
  society: { id: string; name: string }
  household: { name: string; residentType: ResidentType; accessLevel: AccessLevel }[]
}

export interface LoginCode {
  /** Grouped in fours, e.g. MWRT-4K9P-2BHD */
  code: string
  expiresAt: string
  user: { id: string; name: string }
}

export interface ResidentFilters {
  /** A resident name or mobile, a flat number, a block-flat label like A-101, or a flat id */
  search?: string
  status?: VerificationStatus
  residentType?: ResidentType
  active?: 'true' | 'false'
}

export interface RegisterResidentBody {
  name: string
  phone: string
  email?: string
  dateOfBirth?: string
  gender?: Gender
  preferredLanguage?: PreferredLanguage
  alternatePhone?: string
  emergencyContactName?: string
  emergencyContactRelationship?: string
  emergencyContactPhone?: string
  /** How this person relates to the flat: Self, Spouse, Son, Parent */
  relationship?: string
  residentType: ResidentType
  accessLevel?: AccessLevel
  startDate?: string
  endDate?: string
  idDocumentType?: IdDocumentType
  idDocumentLast4?: string
  proofReference?: string
}

/** Every call carries the access token; the server decides scope from it, never from the request. */
export function call<T>(token: string, method: string, path: string, body?: unknown) {
  return send<T>(`/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

export const listSocieties = (token: string) => call<Society[]>(token, 'GET', '/societies')
export interface SocietyBody {
  name?: string
  address?: string | null
  registrationNumber?: string | null
  gstin?: string | null
  pinCode?: string | null
  city?: string | null
  state?: string | null
  officePhone?: string | null
}
export const updateSociety = (token: string, id: string, body: SocietyBody) => call<Society>(token, 'PUT', `/societies/${id}`, body)

export const listGates = (token: string, societyId: string) => call<Gate[]>(token, 'GET', `/societies/${societyId}/gates`)
export const createGate = (token: string, societyId: string, body: { name: string; usedFor?: GateUse }) =>
  call<Gate>(token, 'POST', `/societies/${societyId}/gates`, body)
export const updateGate = (token: string, id: string, body: { name?: string; usedFor?: GateUse; status?: Status; reason?: string }) =>
  call<Gate>(token, 'PUT', `/gates/${id}`, body)
export const getOccupancy = (token: string, societyId: string) => call<Occupancy>(token, 'GET', `/societies/${societyId}/occupancy`)

export const listBlocks = (token: string, societyId: string) => call<Block[]>(token, 'GET', `/societies/${societyId}/blocks`)
export const createBlock = (token: string, societyId: string, body: { name: string }) =>
  call<Block>(token, 'POST', `/societies/${societyId}/blocks`, body)
export const updateBlock = (token: string, id: string, body: { name?: string; status?: Status; reason?: string }) =>
  call<Block>(token, 'PUT', `/blocks/${id}`, body)

export const listFloors = (token: string, blockId: string) => call<Floor[]>(token, 'GET', `/blocks/${blockId}/floors`)
export const createFloor = (token: string, blockId: string, body: { floorLabel: string; sortOrder?: number | null }) =>
  call<Floor>(token, 'POST', `/blocks/${blockId}/floors`, body)
export const updateFloor = (
  token: string,
  id: string,
  body: { floorLabel?: string; sortOrder?: number | null; status?: Status; reason?: string },
) => call<Floor>(token, 'PUT', `/floors/${id}`, body)

export const listFlats = (token: string, floorId: string) => call<Flat[]>(token, 'GET', `/floors/${floorId}/flats`)
export const createFlat = (token: string, floorId: string, body: FlatBody & { number: string }) =>
  call<Flat>(token, 'POST', `/floors/${floorId}/flats`, body)
export const updateFlat = (token: string, id: string, body: FlatBody & { floorId?: string; status?: Status; reason?: string }) =>
  call<Flat>(token, 'PUT', `/flats/${id}`, body)

export function listResidents(token: string, societyId: string, filters: ResidentFilters = {}) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString()
  return call<Resident[]>(token, 'GET', `/societies/${societyId}/residents${query ? `?${query}` : ''}`)
}
export const listFlatResidents = (token: string, flatId: string) => call<Resident[]>(token, 'GET', `/flats/${flatId}/residents`)
export const registerResident = (token: string, flatId: string, body: RegisterResidentBody) =>
  call<Resident & { loginCode: LoginCode | null }>(token, 'POST', `/flats/${flatId}/residents`, body)
/** A one-time code to hand over so the person can set their own password. */
export const issueLoginCode = (token: string, userId: string) =>
  call<LoginCode>(token, 'POST', `/users/${userId}/login-code`)
export const verifyResident = (token: string, id: string, body: { accessLevel?: AccessLevel } = {}) =>
  call<Resident>(token, 'POST', `/residents/${id}/verify`, body)
export const rejectResident = (token: string, id: string, body: { reason: string }) =>
  call<Resident>(token, 'POST', `/residents/${id}/reject`, body)
export const updateResident = (
  token: string,
  id: string,
  body: { endDate?: string | null; accessLevel?: AccessLevel; visitorApprovalEligible?: boolean; reason?: string },
) => call<Resident>(token, 'PUT', `/residents/${id}`, body)

/** The signed-in person's own assignments. No management permission; the server returns only their rows. */
export const listMyFlats = (token: string) => call<MyAssignment[]>(token, 'GET', '/me/flats')

export interface SocietySettings {
  societyId: string
  timezone: string
  /** When true, staff cannot be registered without a government ID */
  idRequired: boolean
  /** The visitor types the gate offers; empty means all of them */
  visitorPurposes: string[]
  leaveAtGateAllowed: boolean
}

export const getSettings = (token: string, societyId: string) =>
  call<SocietySettings>(token, 'GET', `/societies/${societyId}/settings`)

export const updateSettings = (
  token: string,
  societyId: string,
  body: Partial<Pick<SocietySettings, 'timezone' | 'idRequired' | 'visitorPurposes' | 'leaveAtGateAllowed'>>,
) =>
  call<SocietySettings>(token, 'PUT', `/societies/${societyId}/settings`, body)

export type BackupStatus = 'PENDING' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED'

export interface BackupJob {
  id: string
  status: BackupStatus
  byteSize: number | null
  errorCode: string | null
  createdAt: string
  completedAt: string | null
  expiresAt: string | null
  downloadedAt: string | null
}

export const listBackups = (token: string, societyId: string) =>
  call<BackupJob[]>(token, 'GET', `/societies/${societyId}/backups`)

export const requestBackup = (token: string, societyId: string) =>
  call<BackupJob>(token, 'POST', `/societies/${societyId}/backups`, {})

/** Spends the single-use link and hands the encrypted archive to the browser. */
export async function downloadBackup(token: string, jobId: string) {
  const res = await fetch(`/api/v1/backups/${jobId}/download`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error('That download link is no longer valid. Export a new backup.')
  const url = URL.createObjectURL(await res.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = `civickey-backup-${jobId}.sql.gz.enc`
  link.click()
  URL.revokeObjectURL(url)
}
