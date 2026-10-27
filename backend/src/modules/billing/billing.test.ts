import request from 'supertest'
import { eq } from 'drizzle-orm'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { flats, invoices, payments, receipts } from '../../db/schema.js'
import { addResident, createFlat, createUser, grantPermissions, TEST_SOCIETY_ID, signTestToken } from '../../test/helpers.js'

const app = createApp()

let auth: string
let flatId: string

async function tokenFor(user: { id: string; role: 'ADMIN' | 'RESIDENT' | 'GUARD' }) {
  return `Bearer ${await signTestToken({ userId: user.id, role: user.role, societyId: TEST_SOCIETY_ID })}`
}

const api = {
  get: (path: string, token = auth) => request(app).get(`/api/v1${path}`).set('Authorization', token),
  post: (path: string, body: object = {}, token = auth) =>
    request(app).post(`/api/v1${path}`).set('Authorization', token).send(body),
}

const RATES = {
  chargeBasis: 'PER_SQFT' as const,
  rate: 3.5,
  sinkingFund: 500,
  parkingCharge: 300,
  effectiveFrom: '2026-01-01',
}

const setRates = (body: object = RATES) => api.post(`/societies/${TEST_SOCIETY_ID}/billing-rates`, body)
const preview = (body: object) => api.post(`/societies/${TEST_SOCIETY_ID}/invoices/preview`, body)
const generate = (body: object) => api.post(`/societies/${TEST_SOCIETY_ID}/invoices`, body)

/** An occupied flat of 1,000 sq ft with two parking slots */
async function occupiedFlat(number = '101', area: number | null = 1000, slots = 'P-12, P-13') {
  const flat = await createFlat(TEST_SOCIETY_ID, number)
  await db.update(flats).set({ carpetAreaSqft: area, parkingSlots: slots }).where(eq(flats.id, flat.id))
  const resident = await createUser({
    phone: `98${number.padStart(8, '0')}`,
    email: null,
  })
  await addResident(flat.id, resident.id)
  return flat
}

beforeEach(async () => {
  const admin = await createUser({
    phone: '9000000001',
    email: null,
    role: 'ADMIN',
  })
  await grantPermissions(admin.id, ['BILLING_RATE_SET', 'INVOICE_GENERATE', 'PAYMENT_CASH_MARK', 'REPORT_VIEW'])
  auth = await tokenFor(admin)
  flatId = (await occupiedFlat()).id
})

describe('authorization', () => {
  it('asks for the permission printed on each panel', async () => {
    const reporter = await createUser({
      phone: '9000000005',
      email: null,
      role: 'ADMIN',
    })
    await grantPermissions(reporter.id, ['REPORT_VIEW'])
    const token = await tokenFor(reporter)

    expect((await request(app).get(`/api/v1/societies/${TEST_SOCIETY_ID}/billing-rates`)).status).toBe(401)
    // Reports may read what has been billed, but not set rates or take money
    expect((await api.get(`/societies/${TEST_SOCIETY_ID}/invoices`, token)).status).toBe(200)
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/billing-rates`, RATES, token)).status).toBe(403)
    expect((await api.post(`/societies/${TEST_SOCIETY_ID}/invoices`, { period: '2026-01' }, token)).status).toBe(403)
  })
})

describe('rates', () => {
  it('keeps every rate it has been given, newest first', async () => {
    expect((await setRates()).status).toBe(201)
    expect((await setRates({ ...RATES, rate: 4, effectiveFrom: '2026-04-01' })).status).toBe(201)

    const list = await api.get(`/societies/${TEST_SOCIETY_ID}/billing-rates`)
    expect(list.body.data.map((rate: { effectiveFrom: string }) => rate.effectiveFrom)).toEqual(['2026-04-01', '2026-01-01'])
    expect(list.body.data[0]).toMatchObject({
      rate: 4,
      sinkingFund: 500,
      parkingCharge: 300,
    })
  })

  it('refuses a second rate from the same date, and a rate of nothing', async () => {
    await setRates()

    expect((await setRates()).status).toBe(409)
    expect((await setRates({ ...RATES, rate: 0, effectiveFrom: '2026-02-01' })).status).toBe(422)
  })
})

describe('invoices', () => {
  it('prices a flat from its area, slots and the one-time charge, writing nothing', async () => {
    await setRates()

    const res = await preview({
      period: '2026-01',
      oneTimeDescription: 'Lift repair',
      oneTimeAmount: 1200,
    })

    // 1,000 sq ft at 3.50 + 500 sinking + 2 slots at 300 + 1,200 one-time
    expect(res.body.data.lines[0]).toMatchObject({
      maintenance: 3500,
      sinkingFund: 500,
      parkingCharge: 600,
      oneTimeAmount: 1200,
      total: 5800,
    })
    expect(res.body.data.dueDate).toBe('2026-01-16')
    expect(await db.select().from(invoices)).toHaveLength(0)
  })

  it('bills occupied flats, leaves the empty ones out unless asked, and never bills a quarter twice', async () => {
    await setRates()
    await occupiedFlat('102')
    const vacant = await createFlat(TEST_SOCIETY_ID, '103')
    await db.update(flats).set({ carpetAreaSqft: 800 }).where(eq(flats.id, vacant.id))

    const first = await generate({ period: '2026-01' })
    expect(first.status).toBe(201)
    expect(first.body.data.generated).toBe(2)

    const again = await generate({ period: '2026-01', flats: 'ALL' })
    expect(again.body.data.generated).toBe(1)
    expect(again.body.data.skipped).toHaveLength(2)
    expect(again.body.data.skipped[0]).toMatchObject({
      reason: 'Already invoiced for this quarter',
    })
  })

  it('says which flats it cannot price, and refuses a quarter with nothing to bill', async () => {
    await setRates()
    await db.update(flats).set({ carpetAreaSqft: null }).where(eq(flats.id, flatId))

    const res = await generate({ period: '2026-01' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_STATE')
    const priced = await preview({ period: '2026-01' })
    expect(priced.body.data.skipped[0]).toMatchObject({
      reason: 'No carpet area on the flat',
    })
  })

  it('needs rates before it can bill anything', async () => {
    const res = await generate({ period: '2026-01' })

    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/Set the maintenance rates/)
  })

  it('bills from the rate in force on the quarter start, not the newest one', async () => {
    await setRates()
    await setRates({ ...RATES, rate: 10, effectiveFrom: '2026-06-01' })

    const firstQuarter = await preview({ period: '2026-01' })

    expect(firstQuarter.body.data.lines[0]!.maintenance).toBe(3500)
    expect((await preview({ period: '2026-07' })).body.data.lines[0]!.maintenance).toBe(10000)
  })
})

describe('payments', () => {
  async function invoice() {
    await setRates()
    await generate({ period: '2026-01' })
    const [row] = await db.select().from(invoices)
    return row!
  }

  it('records cash with a receipt number and settles the invoice in one go', async () => {
    const row = await invoice()

    const paid = await api.post(`/invoices/${row.id}/payments`, {
      amount: 4600,
      receivedOn: '2026-02-05',
      paidBy: 'Riya Sharma',
    })

    expect(paid.status).toBe(201)
    expect(paid.body.data.receiptNumber).toMatch(/^RCT-\d{4}-\d{6}$/)
    expect(paid.body.data.invoice).toMatchObject({ status: 'PAID', paid: 4600, outstanding: 0 })
    expect((await api.get(`/invoices/${row.id}/payments`)).body.data).toHaveLength(1)

    // A settlement always has exactly one receipt, waiting for its PDF
    const [receipt] = await db.select().from(receipts)
    expect(receipt).toMatchObject({ number: paid.body.data.receiptNumber, status: 'PENDING_PDF' })
  })

  it('takes the whole amount or nothing: part of a bill is not a payment', async () => {
    const row = await invoice()

    const tooMuch = await api.post(`/invoices/${row.id}/payments`, { amount: 5000, receivedOn: '2026-02-05' })
    expect(tooMuch.status).toBe(400)
    expect(tooMuch.body.error.message).toMatch(/settled in full/)

    const part = await api.post(`/invoices/${row.id}/payments`, { amount: 1000, receivedOn: '2026-02-05' })
    expect(part.status).toBe(400)

    await api.post(`/invoices/${row.id}/payments`, { amount: 4600, receivedOn: '2026-02-05' })
    expect((await api.post(`/invoices/${row.id}/payments`, { amount: 4600, receivedOn: '2026-02-05' })).status).toBe(400)
  })

  it('reverses a receipt instead of deleting it, and puts the money back on the invoice', async () => {
    const row = await invoice()
    const paid = await api.post(`/invoices/${row.id}/payments`, {
      amount: 4600,
      receivedOn: '2026-02-05',
    })

    const reversed = await api.post(`/payments/${paid.body.data.id}/reverse`, {
      reason: 'Cheque bounced',
    })

    expect(reversed.status).toBe(200)
    expect(reversed.body.data.invoice).toMatchObject({
      status: 'UNPAID',
      paid: 0,
    })
    // The row is still there, with its receipt number and the reason it was reversed
    const [stored] = await db.select().from(payments).where(eq(payments.id, paid.body.data.id))
    expect(stored).toMatchObject({
      receiptNumber: paid.body.data.receiptNumber,
      reversalReason: 'Cheque bounced',
    })
    expect(
      (
        await api.post(`/payments/${paid.body.data.id}/reverse`, {
          reason: 'Again',
        })
      ).status,
    ).toBe(400)
  })
})

describe('reports', () => {
  it('reports collections and dues, and downloads the same rows as CSV', async () => {
    await setRates()
    await generate({ period: '2026-01' })
    const [row] = await db.select().from(invoices)
    await api.post(`/invoices/${row!.id}/payments`, {
      amount: 4600,
      receivedOn: '2026-02-05',
    })

    const report = await api.get(`/societies/${TEST_SOCIETY_ID}/reports?report=COLLECTIONS&period=2026-01`)
    expect(report.body.data.totals).toEqual({
      billed: 4600,
      paid: 4600,
      outstanding: 0,
    })

    const csv = await api.get(`/societies/${TEST_SOCIETY_ID}/reports?report=COLLECTIONS&period=2026-01&format=csv`)
    expect(csv.headers['content-type']).toMatch(/text\/csv/)
    expect(csv.text.split('\n')[0]).toBe('"flat","period","billed","paid","outstanding","dueDate","status"')
    expect(csv.text).toContain('"A-101-101","2026-01-01","4600","4600","0"')
  })

  it('reports occupancy from the assignments themselves', async () => {
    await createFlat(TEST_SOCIETY_ID, '104')

    const res = await api.get(`/societies/${TEST_SOCIETY_ID}/reports?report=OCCUPANCY`)

    expect(res.body.data.totals).toMatchObject({ flats: 2, vacant: 1 })
    expect(res.body.data.rows.find((row: { occupancy: string }) => row.occupancy === 'OWNER_OCCUPIED')).toBeTruthy()
  })
})

describe('quarters', () => {
  it('bills only from a quarter start, and dues it fifteen days later', async () => {
    await setRates()

    const february = await generate({ period: '2026-02' })
    expect(february.status).toBe(422)
    expect(JSON.stringify(february.body.error)).toMatch(/quarter/)

    for (const [period, due] of [
      ['2026-01', '2026-01-16'],
      ['2026-04', '2026-04-16'],
      ['2026-07', '2026-07-16'],
      ['2026-10', '2026-10-16'],
    ]) {
      const quarter = await preview({ period: period! })
      expect(quarter.body.data.dueDate).toBe(due)
    }
  })
})
