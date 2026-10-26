import { createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { createApp } from '../../app.js'
import { db } from '../../db/client.js'
import { flats, gatewayEvents, invoices, paymentAttempts, payments, receipts } from '../../db/schema.js'
import { addResident, createFlat, createUser, grantPermissions, TEST_SOCIETY_ID } from '../../test/helpers.js'
import { signAccessToken } from '../auth/tokens.js'
import { renderPendingReceipts } from './receipt.service.js'

vi.mock('./gateway.js', async () => ({
  ...(await vi.importActual<typeof import('./gateway.js')>('./gateway.js')),
  checkoutConfigured: vi.fn(() => true),
  createOrder: vi.fn(async (_invoiceId: string, amountPaise: number) => ({
    id: 'order_test_1',
    amount: amountPaise,
    currency: 'INR',
  })),
}))
const gateway = vi.mocked(await import('./gateway.js'))

const app = createApp()

let admin: string
let resident: string
let invoiceId: string

const tokenFor = (user: { id: string; role: 'ADMIN' | 'RESIDENT' | 'GUARD' }) =>
  signAccessToken({ userId: user.id, sessionId: 's1', role: user.role, societyId: TEST_SOCIETY_ID }).then((t) => `Bearer ${t}`)

const api = {
  get: (path: string, token = admin) => request(app).get(`/api/v1${path}`).set('Authorization', token),
  post: (path: string, body: object = {}, token = admin) =>
    request(app).post(`/api/v1${path}`).set('Authorization', token).send(body),
}

/** Posts a webhook body signed the way the gateway signs it: HMAC-SHA256 over the raw bytes. */
function webhook(body: object, { signature, eventId = 'evt_1' }: { signature?: string; eventId?: string } = {}) {
  const raw = JSON.stringify(body)
  const signed = signature ?? createHmac('sha256', 'test-webhook-secret').update(raw).digest('hex')
  return request(app)
    .post('/api/v1/payments/razorpay/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', signed)
    .set('X-Razorpay-Event-Id', eventId)
    .send(raw)
}

const captured = (amount: number, orderId = 'order_test_1') => ({
  event: 'payment.captured',
  payload: { payment: { entity: { id: 'pay_test_1', order_id: orderId, amount, currency: 'INR' } } },
})

beforeEach(async () => {
  vi.clearAllMocks()
  gateway.checkoutConfigured.mockReturnValue(true)
  gateway.createOrder.mockImplementation(async (_invoiceId: string, amountPaise: number) => ({
    id: 'order_test_1',
    amount: amountPaise,
    currency: 'INR',
  }))

  const adminUser = await createUser({ phone: '9000000001', email: null, role: 'ADMIN' })
  await grantPermissions(adminUser.id, ['BILLING_RATE_SET', 'INVOICE_GENERATE', 'PAYMENT_CASH_MARK', 'REPORT_VIEW'])
  admin = await tokenFor(adminUser)

  const flat = await createFlat(TEST_SOCIETY_ID, '101')
  await db.update(flats).set({ carpetAreaSqft: 1000 }).where(eq(flats.id, flat.id))
  const residentUser = await createUser({ phone: '9876543210', email: 'riya@example.com' })
  await addResident(flat.id, residentUser.id)
  resident = await tokenFor(residentUser)

  await api.post(`/societies/${TEST_SOCIETY_ID}/billing-rates`, {
    chargeBasis: 'PER_SQFT',
    rate: 3.5,
    sinkingFund: 500,
    parkingCharge: 0,
    effectiveFrom: '2026-01-01',
  })
  await api.post(`/societies/${TEST_SOCIETY_ID}/invoices`, { period: '2026-01' })
  const [invoice] = await db.select().from(invoices)
  invoiceId = invoice!.id
})

describe('checkout', () => {
  it('asks the gateway for the whole outstanding amount and settles nothing yet', async () => {
    const res = await api.post(`/invoices/${invoiceId}/checkout`, {}, resident)

    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ orderId: 'order_test_1', amount: 4000, currency: 'INR' })
    expect(gateway.createOrder).toHaveBeenCalledWith(invoiceId, 400000)

    const [attempt] = await db.select().from(paymentAttempts)
    expect(attempt).toMatchObject({ status: 'CREATED', amountPaise: 400000, providerOrderId: 'order_test_1' })
    expect((await db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0]!.status).toBe('UNPAID')
  })

  it('says so plainly when the society has no gateway credentials', async () => {
    gateway.checkoutConfigured.mockReturnValue(false)

    const res = await api.post(`/invoices/${invoiceId}/checkout`, {}, resident)

    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('PAYMENT_NOT_CONFIGURED')
  })
})

describe('webhook', () => {
  beforeEach(async () => {
    await api.post(`/invoices/${invoiceId}/checkout`, {}, resident)
  })

  it('settles the invoice and issues one receipt, and ignores the retry of the same event', async () => {
    const first = await webhook(captured(400000))

    expect(first.status).toBe(200)
    expect(first.body.data).toEqual({ handled: true, reason: 'SETTLED' })
    expect((await db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0]!.status).toBe('PAID')
    expect((await db.select().from(payments))[0]).toMatchObject({ amount: '4000.00' })
    expect(await db.select().from(receipts)).toHaveLength(1)

    const retry = await webhook(captured(400000))
    expect(retry.body.data).toEqual({ handled: false, reason: 'DUPLICATE' })
    expect(await db.select().from(payments)).toHaveLength(1)
    expect(await db.select().from(gatewayEvents)).toHaveLength(1)
  })

  it('refuses a body that is not signed by the gateway', async () => {
    const res = await webhook(captured(400000), { signature: 'not-a-signature' })

    expect(res.status).toBe(401)
    expect(await db.select().from(payments)).toHaveLength(0)
    expect(await db.select().from(gatewayEvents)).toHaveLength(0)
  })

  it('leaves a short capture for review and the invoice unpaid', async () => {
    const res = await webhook(captured(100000))

    expect(res.body.data.reason).toBe('REVIEW_REQUIRED')
    expect((await db.select().from(paymentAttempts))[0]).toMatchObject({ status: 'REVIEW_REQUIRED' })
    expect((await db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0]!.status).toBe('UNPAID')
    expect(await db.select().from(payments)).toHaveLength(0)
  })

  it('records a failed attempt without touching the invoice', async () => {
    const res = await webhook({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_x', order_id: 'order_test_1', error_description: 'Card declined' } } },
    })

    expect(res.body.data.reason).toBe('FAILED')
    expect((await db.select().from(paymentAttempts))[0]).toMatchObject({
      status: 'FAILED',
      failureReason: 'Card declined',
    })
    expect((await db.select().from(invoices).where(eq(invoices.id, invoiceId)))[0]!.status).toBe('UNPAID')
  })

  it('ignores an event for an order this society never started', async () => {
    const res = await webhook(captured(400000, 'order_somebody_else'))

    expect(res.body.data.reason).toBe('IGNORED')
    expect(await db.select().from(payments)).toHaveLength(0)
  })
})

describe('receipts', () => {
  it('renders the PDF after settlement and serves it to the resident', async () => {
    await api.post(`/invoices/${invoiceId}/checkout`, {}, resident)
    await webhook(captured(400000))

    expect(await renderPendingReceipts()).toBe(1)
    const [receipt] = await db.select().from(receipts)
    expect(receipt).toMatchObject({ status: 'READY' })
    expect(receipt!.fileId).not.toBeNull()

    const listed = await api.get(`/invoices/${invoiceId}/receipts`, resident)
    expect(listed.body.data[0]).toMatchObject({ number: receipt!.number, status: 'READY' })

    const pdf = await api.get(`/receipts/${receipt!.id}/pdf`, resident)
    expect(pdf.status).toBe(200)
    expect(pdf.headers['content-type']).toContain('application/pdf')
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-')
  })
})
