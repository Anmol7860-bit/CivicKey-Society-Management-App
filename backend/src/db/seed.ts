// Development test accounts: npm run db:seed
import { and, eq } from 'drizzle-orm'
import { env } from '../config/env.js'
import { hashPassword } from '../modules/auth/password.js'
import { db, pool } from './client.js'
import { adminPermission, flatResidents, flats, societies, userPermissions, users, type AdminPermission, type NewUser } from './schema.js'
import { COMMITTEE_PERMISSIONS } from '../modules/access/permissions.js'

if (env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed test accounts in production')
}

const SOCIETY_ID = '5eed0000-0000-4000-8000-000000000001'

type Account = Omit<NewUser, 'passwordHash'> & { password: string; permissions?: readonly AdminPermission[]; flat?: string }

const accounts: Account[] = [
  { name: 'Riya Sharma', phone: '9876543210', role: 'RESIDENT', residentType: 'OWNER', password: 'Resident@123', flat: 'A-101' },
  { name: 'Mahesh Patil', phone: '9876543211', role: 'GUARD', password: 'Guard@123' },
  { name: 'Anita Rao', phone: '9876543212', email: 'admin@civickey.local', role: 'ADMIN', password: 'Admin@123', permissions: adminPermission.enumValues },
  // A Tenant on the committee: Admin role with committee permissions only
  { name: 'Vikram Joshi', phone: '9876543214', role: 'ADMIN', residentType: 'TENANT', password: 'Committee@123', permissions: COMMITTEE_PERMISSIONS, flat: 'B-204' },
  { name: 'Former Resident', phone: '9876543213', role: 'RESIDENT', residentType: 'TENANT', password: 'Inactive@123', isActive: false },
]

try {
  await db.insert(societies).values({ id: SOCIETY_ID, name: 'Green Meadows' }).onConflictDoNothing()

  for (const { password, permissions = [], flat, ...fields } of accounts) {
    const account = { ...fields, societyId: SOCIETY_ID }
    const passwordHash = await hashPassword(password)
    const [user] = await db
      .insert(users)
      .values({ ...account, passwordHash })
      .onConflictDoUpdate({ target: users.phone, set: { ...account, passwordHash, updatedAt: new Date() } })
      .returning({ id: users.id })
    if (flat) {
      const [block, number] = flat.split('-') as [string, string]
      const [row] = await db
        .insert(flats)
        .values({ societyId: SOCIETY_ID, block, number })
        .onConflictDoUpdate({ target: [flats.societyId, flats.block, flats.number], set: { block } })
        .returning({ id: flats.id })
      const linked = await db.select().from(flatResidents).where(and(eq(flatResidents.userId, user!.id), eq(flatResidents.flatId, row!.id)))
      if (linked.length === 0) await db.insert(flatResidents).values({ userId: user!.id, flatId: row!.id })
    }
    if (permissions.length > 0) {
      await db
        .insert(userPermissions)
        .values(permissions.map((permission) => ({ userId: user!.id, permission })))
        .onConflictDoNothing()
    }
  }
  console.log(`Seeded ${accounts.length} users:`)
  console.table(accounts.map(({ name, phone, email, role, password, isActive, flat }) => ({
    name,
    login: phone ?? email,
    password,
    role,
    flat: flat ?? '',
    active: isActive ?? true,
  })))
} finally {
  await pool.end()
}
