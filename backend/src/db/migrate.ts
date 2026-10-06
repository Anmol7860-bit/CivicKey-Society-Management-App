// Applies pending migrations: npm run db:migrate
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { db, pool } from './client.js'
import { migrationsFolder } from './paths.js'

try {
  await migrate(db, { migrationsFolder })
  console.log('Migrations applied')
} finally {
  await pool.end()
}
