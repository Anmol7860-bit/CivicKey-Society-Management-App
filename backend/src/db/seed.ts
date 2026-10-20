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
  permissions as permissionTable,
  societies,
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
  { name: 'Riya Sharma', phone: '9876543210', role: 'RESIDENT', password: 'Resident@123', flat: { block: 'A', floor: '1st Floor', number: '101', type: 'OWNER' } },
  // Co-owner of the same flat: a second OWNER assignment with full access, so either can approve
  { name: 'Priya Sharma', phone: '9876543215', role: 'RESIDENT', password: 'Resident@123', flat: { block: 'A', floor: '1st Floor', number: '101', type: 'OWNER' } },
  { name: 'Mahesh Patil', phone: '9876543211', role: 'GUARD', password: 'Guard@123' },
  { name: 'Anita Rao', phone: '9876543212', email: 'admin@civickey.local', role: 'ADMIN', password: 'Admin@123', permissions: ADMIN_PERMISSIONS },
  // A Tenant on the committee: Admin role with committee permissions only
  { name: 'Vikram Joshi', phone: '9876543214', role: 'ADMIN', password: 'Committee@123', permissions: COMMITTEE_PERMISSIONS, flat: { block: 'B', floor: '2nd Floor', number: '204', sharing: 3, type: 'TENANT' } },
  // A flatmate still in the approval queue: registered, so no access yet
  { name: 'Arjun Nair', phone: '9876543216', role: 'RESIDENT', password: 'Tenant@123', flat: { block: 'B', floor: '2nd Floor', number: '204', sharing: 3, type: 'TENANT', pending: true } },
  { name: 'Former Resident', phone: '9876543213', role: 'RESIDENT', password: 'Inactive@123', isActive: false },
]

/** Finds or creates the block, floor and flat; the unique keys are expressions, so no upsert. */
async function seedFlat({ block, floor, number, sharing }: FlatSpec) {
  const [b] = await db.select().from(blocks).where(and(eq(blocks.societyId, SOCIETY_ID), eq(blocks.name, block)))
  const blockId = (b ?? (await db.insert(blocks).values({ societyId: SOCIETY_ID, name: block }).returning())[0]!).id
  const [f] = await db.select().from(floors).where(and(eq(floors.blockId, blockId), eq(floors.floorLabel, floor)))
  const floorId = (f ?? (await db.insert(floors).values({ blockId, floorLabel: floor }).returning())[0]!).id
  const sharingColumns = { sharingAllowed: sharing !== undefined, maxOccupants: sharing ?? null }
  const [flat] = await db
    .insert(flats)
    .values({ blockId, floorId, number, ...sharingColumns })
    .onConflictDoUpdate({ target: [flats.blockId, flats.number], set: sharingColumns })
    .returning()
  return flat!
}

try {
  await db.insert(societies).values({ id: SOCIETY_ID, name: 'Green Meadows' }).onConflictDoNothing()

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
      endDate: flat.type === 'TENANT' ? IN_A_YEAR : null,
      ...(flat.pending ? {} : { verificationStatus: 'VERIFIED', verifiedBy: granter!, verifiedAt: new Date() }),
    })
  }

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
