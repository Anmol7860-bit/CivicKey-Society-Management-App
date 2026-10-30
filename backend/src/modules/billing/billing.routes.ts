import { Router } from 'express'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { parseOrThrow, validateBody } from '../../middleware/validateBody.js'
import {
  generateInvoicesSchema,
  listInvoicesSchema,
  recordPaymentSchema,
  reportSchema,
  reversePaymentSchema,
  setRatesSchema,
} from './billing.schemas.js'
import * as service from './billing.service.js'
import { handleWebhook, listReceipts, paymentStatus, receiptDetail, receiptFile, startCheckout } from './payment.service.js'
import { readStoredFile } from '../file/file.service.js'

/** Maintenance rates, invoices, cash receipts and the reports built from them. Mounted at /api/v1. */
export function createBillingRouter() {
  const router = Router()
  const setRates = [requireAuth, requirePermission('BILLING_RATE_SET')]
  const generate = [requireAuth, requirePermission('INVOICE_GENERATE')]
  const takePayment = [requireAuth, requirePermission('PAYMENT_CASH_MARK')]
  // Reading what has been billed serves every billing panel, so any of them may list invoices
  const read = [requireAuth, requirePermission('INVOICE_GENERATE', 'PAYMENT_CASH_MARK', 'REPORT_VIEW')]

  router.get('/societies/:societyId/billing-rates', ...read, async (req, res) => {
    res.json({
      data: await service.listRates(req.ctx!, req.params.societyId as string),
    })
  })
  router.post('/societies/:societyId/billing-rates', ...setRates, validateBody(setRatesSchema), async (req, res) => {
    res.status(201).json({
      data: await service.setRates(req.ctx!, req.params.societyId as string, req.body),
    })
  })

  /** The resident's own bills, with the receipts behind each one */
  router.get('/me/invoices', requireAuth, requirePermission('BILL_VIEW_OWN'), async (req, res) => {
    res.json({ data: await service.listMyInvoices(req.ctx!) })
  })

  router.get('/societies/:societyId/invoices', ...read, async (req, res) => {
    const query = parseOrThrow(listInvoicesSchema, req.query)
    res.json({
      data: await service.listInvoices(req.ctx!, req.params.societyId as string, query),
    })
  })
  /** Preview writes nothing: the same arithmetic the Generate button would run */
  router.post('/societies/:societyId/invoices/preview', ...generate, validateBody(generateInvoicesSchema), async (req, res) => {
    res.json({
      data: await service.previewInvoices(req.ctx!, req.params.societyId as string, req.body),
    })
  })
  router.post('/societies/:societyId/invoices', ...generate, validateBody(generateInvoicesSchema), async (req, res) => {
    res.status(201).json({
      data: await service.generateInvoices(req.ctx!, req.params.societyId as string, req.body),
    })
  })

  /** One invoice in full. A Resident reaches their own flat's; anyone else needs a billing permission. */
  router.get(
    '/invoices/:invoiceId',
    requireAuth,
    requirePermission('BILL_VIEW_OWN', 'INVOICE_GENERATE', 'PAYMENT_CASH_MARK', 'REPORT_VIEW'),
    async (req, res) => {
      res.json({ data: await service.getInvoice(req.ctx!, req.params.invoiceId as string) })
    },
  )

  router.get('/invoices/:invoiceId/payments', ...read, async (req, res) => {
    res.json({
      data: await service.listPayments(req.ctx!, req.params.invoiceId as string),
    })
  })
  router.post('/invoices/:invoiceId/payments', ...takePayment, validateBody(recordPaymentSchema), async (req, res) => {
    res.status(201).json({
      data: await service.recordPayment(req.ctx!, req.params.invoiceId as string, req.body),
    })
  })
  router.post('/payments/:paymentId/reverse', ...takePayment, validateBody(reversePaymentSchema), async (req, res) => {
    res.json({
      data: await service.reversePayment(req.ctx!, req.params.paymentId as string, req.body),
    })
  })

  /**
   * The resident opens the gateway's own page with what this returns. It settles nothing: the
   * invoice stays unpaid until the signed webhook arrives, whatever the browser comes back saying.
   */
  router.post('/invoices/:invoiceId/checkout', requireAuth, requirePermission('BILL_PAY'), async (req, res) => {
    res.status(201).json({ data: await startCheckout(req.ctx!, req.params.invoiceId as string) })
  })

  /**
   * What the server knows about a checkout attempt. The page asks this after the gateway window
   * closes, because the window closing is not a payment.
   */
  router.get(
    '/payments/:paymentId',
    requireAuth,
    requirePermission('BILL_PAY', 'INVOICE_GENERATE', 'PAYMENT_CASH_MARK', 'REPORT_VIEW'),
    async (req, res) => {
      res.json({ data: await paymentStatus(req.ctx!, req.params.paymentId as string) })
    },
  )

  /**
   * The gateway's webhook: unauthenticated by nature and trusted only because of its signature,
   * which is checked against the raw body. The raw parser for this one path is registered in
   * app.ts, before the JSON parser that would otherwise consume the bytes.
   */
  router.post('/payments/razorpay/webhook', async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}))
    res.json({ data: await handleWebhook(raw, req.headers) })
  })

  const seeReceipts = [requireAuth, requirePermission('RECEIPT_VIEW_OWN', 'BILL_VIEW_OWN', 'INVOICE_GENERATE', 'PAYMENT_CASH_MARK')]

  router.get('/invoices/:invoiceId/receipts', ...seeReceipts, async (req, res) => {
    res.json({ data: await listReceipts(req.ctx!, req.params.invoiceId as string) })
  })

  router.get('/receipts/:receiptId', ...seeReceipts, async (req, res) => {
    res.json({ data: await receiptDetail(req.ctx!, req.params.receiptId as string) })
  })

  /** The receipt PDF itself, read out of private storage for whoever may see the invoice */
  router.get('/receipts/:receiptId/pdf', ...seeReceipts, async (req, res) => {
    const { fileId, number } = await receiptFile(req.ctx!, req.params.receiptId as string)
    const { bytes } = await readStoredFile(req.ctx!.societyId, fileId)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${number}.pdf"`)
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.send(bytes)
  })

  /** ?format=csv is the Download CSV button; the rows are identical either way */
  router.get('/societies/:societyId/reports', requireAuth, requirePermission('REPORT_VIEW'), async (req, res) => {
    const query = parseOrThrow(reportSchema, req.query)
    const report = await service.runReport(req.ctx!, req.params.societyId as string, query)
    if (query.format !== 'csv') return res.json({ data: report })
    const filename = `${report.report.toLowerCase()}-${query.period ?? 'all'}.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return res.send(service.toCsv(report.columns, report.rows))
  })

  return router
}
