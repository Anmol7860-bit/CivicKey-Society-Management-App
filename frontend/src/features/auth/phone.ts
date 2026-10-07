export const PHONE_LENGTH = 10
export const COUNTRY_CODE = '+91'

/** Keeps the 10 digits after +91. A pasted "+91 98765 43210" drops its country code. */
export function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, '')
  return (digits.length > PHONE_LENGTH && digits.startsWith('91') ? digits.slice(2) : digits).slice(0, PHONE_LENGTH)
}

/** Indian mobile numbers are 10 digits starting with 6, 7, 8 or 9. */
export function isValidPhone(digits: string) {
  return /^[6-9]\d{9}$/.test(digits)
}

/** Formats digits the Indian way: 98765 43210 */
export function formatPhone(digits: string) {
  return digits.length <= 5 ? digits : `${digits.slice(0, 5)} ${digits.slice(5)}`
}
