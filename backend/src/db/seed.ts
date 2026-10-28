// Development test accounts: npm run db:seed
import { and, eq, inArray } from 'drizzle-orm'
import { env } from '../config/env.js'
import { hashPassword } from '../modules/auth/password.js'
import { db, pool } from './client.js'
import {
  blocks,
  flatResidents,
  flats,
  floors,
  flatVehicles,
  gates,
  guardGateAssignments,
  permissions as permissionTable,
  societies,
  staff,
  staffFlats,
  communityTasks,
  visitorPasses,
  visits,
  userPermissions,
  users,
  type NewUser,
  type ResidentType,
  type Role,
} from './schema.js'
import { ADMIN_PERMISSIONS, assignRole, COMMITTEE_PERMISSIONS, type AdminPermission } from '../modules/access/permissions.js'

if (env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed test accounts in production')
}

const SOCIETY_ID = '5eed0000-0000-4000-8000-000000000001'

/** A tenancy must end on a date; a year out keeps the dev data valid for a while. */
const IN_A_YEAR = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

interface FlatSpec {
  block: string
  floor: string
  number: string
  /** What the flat is and how big, so the billing panels have something to work from */
  flatType?: (typeof flats.$inferInsert)['flatType']
  carpetAreaSqft?: number
  parkingSlots?: string
  /** Lets the flat take co-tenants, up to this many */
  sharing?: number
  type: ResidentType
  access?: 'FULL' | 'VIEW_ONLY'
  /** Left awaiting verification, so the Admin's approval queue is not empty */
  pending?: boolean
}

type Account = Omit<NewUser, 'passwordHash'> & {
  role: Role
  password: string
  permissions?: readonly AdminPermission[]
  flat?: FlatSpec
}

const accounts: Account[] = [
  { name: 'Riya Sharma', phone: '9876543210', role: 'RESIDENT', password: 'Resident@123', flat: { block: 'A', floor: '1st Floor', number: '101', type: 'OWNER', flatType: 'TWO_BHK', carpetAreaSqft: 950, parkingSlots: 'P-12' } },
  // Co-owner of the same flat: a second OWNER assignment with full access, so either can approve
  { name: 'Priya Sharma', phone: '9876543215', role: 'RESIDENT', password: 'Resident@123', flat: { block: 'A', floor: '1st Floor', number: '101', type: 'OWNER', flatType: 'TWO_BHK', carpetAreaSqft: 950, parkingSlots: 'P-12' } },
  { name: 'Mahesh Patil', phone: '9876543211', role: 'GUARD', password: 'Guard@123' },
  { name: 'Anita Rao', phone: '9876543212', email: 'admin@civickey.local', role: 'ADMIN', password: 'Admin@123', permissions: ADMIN_PERMISSIONS },
  // A Tenant on the committee: Admin role with committee permissions only
  { name: 'Vikram Joshi', phone: '9876543214', role: 'ADMIN', password: 'Committee@123', permissions: COMMITTEE_PERMISSIONS, flat: { block: 'B', floor: '2nd Floor', number: '204', sharing: 3, type: 'TENANT', flatType: 'THREE_BHK', carpetAreaSqft: 1240, parkingSlots: 'P-24, P-25' } },
  // A flatmate still in the approval queue: registered, so no access yet
  { name: 'Arjun Nair', phone: '9876543216', role: 'RESIDENT', password: 'Tenant@123', flat: { block: 'B', floor: '2nd Floor', number: '204', sharing: 3, type: 'TENANT', flatType: 'THREE_BHK', carpetAreaSqft: 1240, parkingSlots: 'P-24, P-25', pending: true } },
  { name: 'Former Resident', phone: '9876543213', role: 'RESIDENT', password: 'Inactive@123', isActive: false },
]

/** Finds or creates the block, floor and flat; the unique keys are expressions, so no upsert. */
async function seedFlat({ block, floor, number, sharing, flatType, carpetAreaSqft, parkingSlots }: FlatSpec) {
  const [b] = await db.select().from(blocks).where(and(eq(blocks.societyId, SOCIETY_ID), eq(blocks.name, block)))
  const blockId = (b ?? (await db.insert(blocks).values({ societyId: SOCIETY_ID, name: block }).returning())[0]!).id
  const [f] = await db.select().from(floors).where(and(eq(floors.blockId, blockId), eq(floors.floorLabel, floor)))
  const floorId = (f ?? (await db.insert(floors).values({ blockId, floorLabel: floor }).returning())[0]!).id
  const columns = {
    sharingAllowed: sharing !== undefined,
    maxOccupants: sharing ?? null,
    flatType: flatType ?? null,
    carpetAreaSqft: carpetAreaSqft ?? null,
    parkingSlots: parkingSlots ?? null,
  }
  const [flat] = await db
    .insert(flats)
    .values({ blockId, floorId, number, ...columns })
    // floorId too: a flat left on the legacy "Unassigned" floor moves to the one it belongs on
    .onConflictDoUpdate({ target: [flats.blockId, flats.number], set: { ...columns, floorId } })
    .returning()
  return flat!
}

try {
  await db.insert(societies).values({ id: SOCIETY_ID, name: 'Green Meadows' }).onConflictDoNothing()

  // A gate and a rate, so Staff management and Billing have something to work with on first run
  const [gate] = await db
    .insert(gates)
    .values({ societyId: SOCIETY_ID, code: 'MAIN', name: 'Main gate' })
    .onConflictDoNothing()
    .returning()
  const gateId = (gate ?? (await db.select().from(gates).where(eq(gates.societyId, SOCIETY_ID)))[0])?.id

  // The first Admin grants everyone's permissions, including (as the bootstrap account) their own
  let granter: string | undefined
  const assignments: { userId: string; flat: FlatSpec }[] = []

  for (const { role, password, permissions = [], flat, ...fields } of accounts) {
    const account = { ...fields, societyId: SOCIETY_ID }
    const passwordHash = await hashPassword(password)
    const [user] = await db
      .insert(users)
      .values({ ...account, passwordHash })
      .onConflictDoUpdate({ target: users.phone, set: { ...account, passwordHash, updatedAt: new Date() } })
      .returning({ id: users.id })
    await assignRole(db, user!.id, role)
    if (flat) assignments.push({ userId: user!.id, flat })
    if (permissions.length > 0) {
      granter ??= user!.id
      const ids = await db.select({ id: permissionTable.id }).from(permissionTable).where(inArray(permissionTable.code, [...permissions]))
      await db
        .insert(userPermissions)
        .values(ids.map(({ id }) => ({ userId: user!.id, permissionId: id, grantedBy: granter! })))
        .onConflictDoUpdate({ target: [userPermissions.userId, userPermissions.permissionId], set: { revokedAt: null } })
    }
  }

  // Assignments come last: the Admin recorded as verifier only exists once every account is in
  for (const { userId, flat } of assignments) {
    const row = await seedFlat(flat)
    const linked = await db
      .select()
      .from(flatResidents)
      .where(and(eq(flatResidents.userId, userId), eq(flatResidents.flatId, row.id)))
    if (linked.length > 0) continue
    await db.insert(flatResidents).values({
      userId,
      flatId: row.id,
      residentType: flat.type,
      accessLevel: flat.access ?? 'FULL',
      visitorApprovalEligible: (flat.access ?? 'FULL') === 'FULL',
      endDate: flat.type === 'TENANT' ? IN_A_YEAR : null,
      ...(flat.pending ? {} : { verificationStatus: 'VERIFIED', verifiedBy: granter!, verifiedAt: new Date() }),
    })
  }

  if (gateId) {
    const [help] = await db
      .insert(staff)
      .values({
        societyId: SOCIETY_ID,
        kind: 'DAILY_HELP',
        name: 'Sunita Devi',
        phone: '9876543220',
        workType: 'Maid',
        workingDays: 'MON,TUE,WED,THU,FRI,SAT',
        policeVerification: 'VERIFIED',
        passCode: 'CK-SEEDHELP',
      })
      .onConflictDoNothing()
      .returning()
    // The flat she works for, so the Daily help record serves someone. On a re-run the insert
    // conflicts and returns nothing, so the existing row is read back instead.
    const staffId = (help ?? (await db.select().from(staff).where(eq(staff.phone, '9876543220')))[0])?.id
    const [firstFlat] = await db.select().from(flats).limit(1)
    if (staffId && firstFlat) {
      await db.insert(staffFlats).values({ staffId, flatId: firstFlat.id, timeWindow: '7-9 am' }).onConflictDoNothing()
    }

    // The guard who signs in needs the profile and the posting behind the account: without them
    // the account is a login with nothing to do, and no gate operation would be authorized.
    const [guardAccount] = await db.select({ id: users.id }).from(users).where(eq(users.phone, '9876543211'))
    if (guardAccount) {
      await db
        .insert(staff)
        .values({
          societyId: SOCIETY_ID,
          kind: 'GUARD',
          userId: guardAccount.id,
          name: 'Mahesh Patil',
          phone: '9876543211',
          agency: 'SafeGuard',
          gateId,
          shift: 'MORNING',
          policeVerification: 'VERIFIED',
          passCode: 'CK-SEEDGUARD',
        })
        .onConflictDoNothing()
      await db
        .insert(guardGateAssignments)
        .values({ guardUserId: guardAccount.id, gateId, assignedBy: granter ?? guardAccount.id })
        .onConflictDoNothing()
    }
  }

  // Something at the gate on first run: a visitor waiting, a pass in hand and a registered car
  const [firstFlatForGate] = await db.select().from(flats).limit(1)
  if (gateId && firstFlatForGate) {
    const [guard] = await db.select().from(users).where(eq(users.phone, '9876543211'))
    const [owner] = await db.select().from(users).where(eq(users.phone, '9876543210'))
    await db
      .insert(visits)
      .values({
        societyId: SOCIETY_ID,
        gateId,
        flatId: firstFlatForGate.id,
        visitorName: 'Amit Kulkarni',
        visitorPhone: '9822222222',
        purpose: 'GUEST',
        people: 2,
        vehicleNumber: 'MH 12 AB 3344',
        registeredBy: guard?.id ?? null,
      })
      .onConflictDoNothing()
    if (owner) {
      await db
        .insert(visitorPasses)
        .values({
          societyId: SOCIETY_ID,
          flatId: firstFlatForGate.id,
          createdBy: owner.id,
          visitorName: 'Mahesh the plumber',
          visitorPhone: '9844444444',
          purpose: 'SERVICE',
          validOn: new Date().toISOString().slice(0, 10),
          validFrom: '08:00',
          validUntil: '20:00',
          note: 'Fixing the kitchen tap',
          entryCode: '482913',
        })
        .onConflictDoNothing()
      await db
        .insert(flatVehicles)
        .values({ societyId: SOCIETY_ID, flatId: firstFlatForGate.id, number: 'MH 12 CK 0101', vehicleType: 'CAR', makeColour: 'Swift, white', addedBy: owner.id })
        .onConflictDoNothing()
    }
  }

  // Something on the work list, so Community tasks is not empty on a fresh database
  const [officeAdmin] = await db.select().from(users).where(eq(users.phone, '9876543212'))
  const [vendor] = await db.select().from(staff).where(eq(staff.phone, '9876543220'))
  await db
    .insert(communityTasks)
    .values({
      societyId: SOCIETY_ID,
      title: 'Lobby light is out',
      details: 'Second tube from the lift. Needs a starter as well.',
      category: 'ELECTRICAL',
      priority: 'HIGH',
      location: 'B wing lobby',
      dueDate: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
      assignedStaffId: vendor?.id ?? null,
      raisedBy: officeAdmin?.id ?? null,
    })
    .onConflictDoNothing()

  console.log(`Seeded ${accounts.length} users:`)
  console.table(accounts.map(({ name, phone, email, role, password, isActive, flat }) => ({
    name,
    login: phone ?? email,
    password,
    role,
    flat: flat ? `${flat.block}-${flat.number}` : '',
    assignment: flat ? `${flat.type}${flat.pending ? ' (pending)' : ''}` : '',
    active: isActive ?? true,
  })))
} finally {
  await pool.end()
}
