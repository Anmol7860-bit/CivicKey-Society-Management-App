import { execSync } from 'node:child_process'

// Upserts the test accounts (active resident/guard/admin + one inactive resident)
export default function globalSetup() {
  execSync('npm run db:seed', { cwd: '../backend', stdio: 'ignore' })
}
