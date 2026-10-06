export const PHONE_LENGTH = 10

/** Strips everything but digits and caps the length. */
export function normalizePhone(value: string) {
  return value.replace(/\D/g, '').slice(0, PHONE_LENGTH)
}

/** Formats digits as the design shows them: (312) 555-0148 */
export function formatPhone(digits: string) {
  if (digits.length === 0) return ''
  if (digits.length <= 3) return `(${digits}`
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
}
