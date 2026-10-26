import { isoDay, today } from './day'

it('reads the local calendar day, not the UTC one', () => {
  // 01:30 local on the 5th: toISOString() would say the 4th anywhere east of UTC
  expect(isoDay(new Date(2026, 0, 5, 1, 30))).toBe('2026-01-05')
  // Single digits are padded, and late evening stays on its own day west of UTC
  expect(isoDay(new Date(2026, 8, 9, 23, 45))).toBe('2026-09-09')
  expect(today()).toBe(isoDay(new Date()))
})
