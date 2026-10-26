/**
 * The calendar day as the person in front of the screen reads it.
 *
 * `new Date().toISOString().slice(0, 10)` is the obvious way to write this and it is wrong east of
 * UTC: between midnight and 05:30 in India it reports yesterday, so a date input defaulted that way
 * hands the server a date already in the past. Every default date and `max` goes through here.
 */
export function isoDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export const today = () => isoDay()
