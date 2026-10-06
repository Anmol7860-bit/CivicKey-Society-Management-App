// Development test accounts: npm run db:seed
import { env } from '../config/env.js'
import { hashPassword } from '../modules/auth/password.js'
import { db, pool } from './client.js'
import { users, type NewUser } from './schema.js'

if (env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed test accounts in production')
}

const accounts: Array<Omit<NewUser, 'passwordHash'> & { password: string }> = [
  { name: 'Riya Sharma', phone: '9876543210', role: 'RESIDENT', password: 'Resident@123' },
  { name: 'Mahesh Patil', phone: '9876543211', role: 'GUARD', password: 'Guard@123' },
  { name: 'Anita Rao', phone: '9876543212', email: 'admin@civickey.local', role: 'ADMIN', password: 'Admin@123' },
  { name: 'Former Resident', phone: '9876543213', role: 'RESIDENT', password: 'Inactive@123', isActive: false },
]

try {
  for (const { password, ...account } of accounts) {
    const passwordHash = await hashPassword(password)
    await db
      .insert(users)
      .values({ ...account, passwordHash })
      .onConflictDoUpdate({ target: users.phone, set: { ...account, passwordHash, updatedAt: new Date() } })
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
