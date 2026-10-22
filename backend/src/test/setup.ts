// Runs before each test file. Env must be set before any app module is imported.
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/civickey_test'
process.env.JWT_ACCESS_SECRET = 'test-secret-that-is-at-least-thirty-two-characters'
process.env.BCRYPT_COST = '4'
process.env.ID_HASH_PEPPER = 'test-pepper-at-least-thirty-two-characters'
process.env.LOGIN_RATE_LIMIT_MAX = '5'

const { migrate } = await import('drizzle-orm/node-postgres/migrator')
const { db, pool } = await import('../db/client.js')
const { migrationsFolder } = await import('../db/paths.js')

beforeAll(async () => {
  await migrate(db, { migrationsFolder })
})

beforeEach(async () => {
  await pool.query('TRUNCATE payments, invoices, billing_rates, staff_flats, staff, gates, flat_residents, flats, floors, blocks, user_permissions, user_roles, audit_logs, refresh_tokens, auth_sessions, users, societies RESTART IDENTITY CASCADE')
  // roles, permissions and role_permissions are master data from migrations and are kept
})

afterAll(async () => {
  await pool.end()
})
