// Development test accounts: npm run db:seed
import { env } from '../config/env.js'
import { hashPassword } from '../modules/auth/password.js'
import { db, pool } from './client.js'
import { adminPermission, userPermissions, users, type AdminPermission, type NewUser } from './schema.js'
import { COMMITTEE_PERMISSIONS } from '../modules/access/permissions.js'

if (env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed test accounts in production')
}

const accounts: Array<Omit<NewUser, 'passwordHash'> & { password: string; permissions?: readonly AdminPermission[] }> = [
  { name: 'Riya Sharma', phone: '9876543210', role: 'RESIDENT', residentType: 'OWNER', password: 'Resident@123' },
  { name: 'Mahesh Patil', phone: '9876543211', role: 'GUARD', password: 'Guard@123' },
  { name: 'Anita Rao', phone: '9876543212', email: 'admin@civickey.local', role: 'ADMIN', password: 'Admin@123', permissions: adminPermission.enumValues },
  // A Tenant on the committee: Admin role with committee permissions only
  { name: 'Vikram Joshi', phone: '9876543214', role: 'ADMIN', residentType: 'TENANT', password: 'Committee@123', permissions: COMMITTEE_PERMISSIONS },
  { name: 'Former Resident', phone: '9876543213', role: 'RESIDENT', residentType: 'TENANT', password: 'Inactive@123', isActive: false },
]

try {
  for (const { password, permissions = [], ...account } of accounts) {
    const passwordHash = await hashPassword(password)
    const [user] = await db
      .insert(users)
      .values({ ...account, passwordHash })
      .onConflictDoUpdate({ target: users.phone, set: { ...account, passwordHash, updatedAt: new Date() } })
      .returning({ id: users.id })
    if (permissions.length > 0) {
      await db
        .insert(userPermissions)
        .values(permissions.map((permission) => ({ userId: user!.id, permission })))
        .onConflictDoNothing()
    }
  }
  console.log(`Seeded ${accounts.length} users:`)
  console.table(accounts.map(({ name, phone, email, role, password, isActive }) => ({
    name,
    login: phone ?? email,
    password,
    role,
    active: isActive ?? true,
  })))
} finally {
  await pool.end()
}
