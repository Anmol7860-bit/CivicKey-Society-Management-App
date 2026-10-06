import bcrypt from 'bcrypt'
import { env } from '../../config/env.js'

export function hashPassword(plain: string) {
  return bcrypt.hash(plain, env.BCRYPT_COST)
}

let dummyHash: Promise<string> | undefined

/**
 * Compares against a real hash, or against a throwaway hash when the user does not
 * exist, so response time does not reveal whether a phone/email is registered.
 */
export async function verifyPassword(plain: string, hash: string | undefined) {
  if (hash) return bcrypt.compare(plain, hash)
  dummyHash ??= bcrypt.hash('civickey-timing-equalizer', env.BCRYPT_COST)
  await bcrypt.compare(plain, await dummyHash)
  return false
}
