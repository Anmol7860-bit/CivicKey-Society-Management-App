// Development test accounts: npm run db:seed
import { and, eq, inArray } from 'drizzle-orm'
import { env } from '../config/env.js'
import { hashPassword } from '../modules/auth/password.js'
import { db, pool } from './client.js'
import { blocks, flatResidents, flats, floors, permissions as permissionTable, societies, userPermissions, users, type NewUser, type Role } from './schema.js'
import { ADMIN_PERMISSIONS, assignRole, COMMITTEE_PERMISSIONS, type AdminPermission } from '../modules/access/permissions.js'

if (env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed test accounts in production')
}

const SOCIETY_ID = '5eed0000-0000-4000-8000-000000000001'

type Account = Omit<NewUser, 'passwordHash'> & { role: Role; password: string; permissions?: readonly AdminPermission[]; flat?: { block: string; floor: string; number: string } }

const accounts: Account[] = [
  { name: 'Riya Sharma', phone: '9876543210', role: 'RESIDENT', residentType: 'OWNER', password: 'Resident@123', flat: { block: 'A', floor: '1st Floor', number: '101' } },
  { name: 'Mahesh Patil', phone: '9876543211', role: 'GUARD', password: 'Guard@123' },
  { name: 'Anita Rao', phone: '9876543212', email: 'admin@civickey.local', role: 'ADMIN', password: 'Admin@123', permissions: ADMIN_PERMISSIONS },
  // A Tenant on the committee: Admin role with committee permissions only
  { name: 'Vikram Joshi', phone: '9876543214', role: 'ADMIN', residentType: 'TENANT', password: 'Committee@123', permissions: COMMITTEE_PERMISSIONS, flat: { block: 'B', floor: '2nd Floor', number: '204' } },
  { name: 'Former Resident', phone: '9876543213', role: 'RESIDENT', residentType: 'TENANT', password: 'Inactive@123', isActive: false },
]

/** Finds or creates the block, floor and flat; the unique keys are expressions, so no upsert. */
async function seedFlat({ block, floor, number }: NonNullable<Account['flat']>) {
  const [b] = await db.select().from(blocks).where(and(eq(blocks.societyId, SOCIETY_ID), eq(blocks.name, block)))
  const blockId = (b ?? (await db.insert(blocks).values({ societyId: SOCIETY_ID, name: block }).returning())[0]!).id
  const [f] = await db.select().from(floors).where(and(eq(floors.blockId, blockId), eq(floors.label, floor)))
  const floorId = (f ?? (await db.insert(floors).values({ blockId, label: floor }).returning())[0]!).id
  const [existing] = await db.select().from(flats).where(and(eq(flats.blockId, blockId), eq(flats.number, number)))
  return existing ?? (await db.insert(flats).values({ societyId: SOCIETY_ID, blockId, floorId, number }).returning())[0]!
}

try {
  await db.insert(societies).values({ id: SOCIETY_ID, name: 'Green Meadows' }).onConflictDoNothing()

  // The first Admin grants everyone's permissions, including (as the bootstrap account) their own
  let granter: string | undefined

  for (const { role, password, permissions = [], flat, ...fields } of accounts) {
    const account = { ...fields, societyId: SOCIETY_ID }
    const passwordHash = await hashPassword(password)
    const [user] = await db
      .insert(users)
      .values({ ...account, passwordHash })
      .onConflictDoUpdate({ target: users.phone, set: { ...account, passwordHash, updatedAt: new Date() } })
      .returning({ id: users.id })
    await assignRole(db, user!.id, role)
    if (flat) {
      const row = await seedFlat(flat)
      const linked = await db.select().from(flatResidents).where(and(eq(flatResidents.userId, user!.id), eq(flatResidents.flatId, row!.id)))
      if (linked.length === 0) await db.insert(flatResidents).values({ userId: user!.id, flatId: row.id })
    }
    if (permissions.length > 0) {
      granter ??= user!.id
      const ids = await db.select({ id: permissionTable.id }).from(permissionTable).where(inArray(permissionTable.code, [...permissions]))
      await db
        .insert(userPermissions)
        .values(ids.map(({ id }) => ({ userId: user!.id, permissionId: id, grantedBy: granter! })))
        .onConflictDoUpdate({ target: [userPermissions.userId, userPermissions.permissionId], set: { revokedAt: null } })
    }
  }
  console.log(`Seeded ${accounts.length} users:`)
  console.table(accounts.map(({ name, phone, email, role, password, isActive, flat }) => ({
    name,
    login: phone ?? email,
    password,
    role,
    flat: flat ? `${flat.block}-${flat.number}` : '',
    active: isActive ?? true,
  })))
} finally {
  await pool.end()
}
