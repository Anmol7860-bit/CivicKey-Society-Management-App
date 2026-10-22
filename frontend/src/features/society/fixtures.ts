import type { OccupancyFlat, Society } from './api'

/** Test fixtures: a society and a flat with every field the API returns, overridable per test. */
export const aSociety = (overrides: Partial<Society> = {}): Society => ({
  id: 's1',
  name: 'Green Meadows',
  address: null,
  registrationNumber: null,
  gstin: null,
  pinCode: null,
  city: null,
  state: null,
  officePhone: null,
  ...overrides,
})

export const aFlat = (overrides: Partial<OccupancyFlat> = {}): OccupancyFlat => ({
  id: 'fl1',
  blockId: 'b1',
  floorId: 'f1',
  number: '101',
  status: 'ACTIVE',
  sharingAllowed: false,
  maxOccupants: null,
  flatType: null,
  carpetAreaSqft: null,
  parkingSlots: null,
  parkingSlotCount: 0,
  intercom: null,
  residents: [],
  owners: 0,
  tenants: 0,
  occupants: 0,
  slotsLeft: null,
  ownership: 'UNSOLD',
  occupancy: 'VACANT',
  ...overrides,
})
