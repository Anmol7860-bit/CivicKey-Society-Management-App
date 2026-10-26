// The first society and its first General Admin: npm run bootstrap:society
//
// Public signup does not exist in CivicKey, so one account has to come from outside the app. This
// command is that account, and it refuses to run a second time: everything after the first society
// is managed in the Admin UI.
import { parseArgs } from 'node:util'
import { count, inArray } from 'drizzle-orm'
import { ADMIN_PERMISSIONS, assignRole } from '../modules/access/permissions.js'
import { hashPassword } from '../modules/auth/password.js'
import { db, pool } from './client.js'
import { gates, permissions as permissionTable, societies, societySettings, userPermissions, users } from './schema.js'

const OPTIONS = {
  name: { type: 'string' },
  address: { type: 'string' },
  city: { type: 'string' },
  state: { type: 'string' },
  'pin-code': { type: 'string' },
  timezone: { type: 'string', default: 'Asia/Kolkata' },
  'admin-name': { type: 'string' },
  'admin-phone': { type: 'string' },
  gate: { type: 'string', default: 'Main gate' },
} as const

const REQUIRED = ['name', 'address', 'city', 'state', 'pin-code', 'admin-name', 'admin-phone'] as const

const USAGE = `Usage: npm run bootstrap:society -- \\
  --name "Green Meadows" --address "12 MG Road" --city Pune --state Maharashtra \\
  --pin-code 411001 --admin-name "Anita Desai" --admin-phone 9876543210 \\
  [--timezone Asia/Kolkata] [--gate "Main gate"]`

/** 16 characters of base32-ish alphabet: longer than the 12 the baseline asks for, and readable. */
function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `Ck-${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join('')}`
}

async function main() {
  const { values } = parseArgs({ options: OPTIONS, allowPositionals: false })
  const missing = REQUIRED.filter((flag) => !values[flag])
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.map((flag) => `--${flag}`).join(', ')}\n\n${USAGE}`)
  }
  if (!/^[6-9][0-9]{9}$/.test(values['admin-phone']!)) throw new Error('--admin-phone must be a 10-digit Indian mobile number')
  if (!/^[1-9][0-9]{5}$/.test(values['pin-code']!)) throw new Error('--pin-code must be 6 digits')

  const [existing] = await db.select({ societies: count() }).from(societies)
  if ((existing?.societies ?? 0) > 0) {
    throw new Error('This database already has a society. Use the Admin UI, or an empty database.')
  }

  const password = temporaryPassword()
  const passwordHash = await hashPassword(password)

  const result = await db.transaction(async (tx) => {
    const [society] = await tx
      .insert(societies)
      .values({
        name: values.name!,
        address: values.address!,
        city: values.city!,
        state: values.state!,
        pinCode: values['pin-code']!,
      })
      .returning()
    await tx.insert(societySettings).values({ societyId: society!.id, timezone: values.timezone })
    const [gate] = await tx
      .insert(gates)
      .values({ societyId: society!.id, code: 'MAIN', name: values.gate })
      .returning()

    const [admin] = await tx
      .insert(users)
      .values({
        societyId: society!.id,
        name: values['admin-name']!,
        phone: values['admin-phone']!,
        passwordHash,
      })
      .returning()
    await assignRole(tx, admin!.id, 'ADMIN')
    // The first Admin holds every admin permission, granted by themselves: there is nobody else
    // yet who could have granted them
    const granted = await tx
      .select({ id: permissionTable.id })
      .from(permissionTable)
      .where(inArray(permissionTable.code, [...ADMIN_PERMISSIONS]))
    await tx
      .insert(userPermissions)
      .values(granted.map(({ id }) => ({ userId: admin!.id, permissionId: id, grantedBy: admin!.id })))

    return { society: society!, gate: gate!, admin: admin! }
  })

  // Shown once: nothing stores the password, only its hash
  console.log(`
Society:     ${result.society.name} (${result.society.id})
Gate:        ${result.gate.name}
Admin:       ${result.admin.name}, phone ${result.admin.phone}
Password:    ${password}

Give that password to the Admin and have them change it at first sign-in. It is not stored
anywhere and cannot be shown again.`)
}

try {
  await main()
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await pool.end()
}
