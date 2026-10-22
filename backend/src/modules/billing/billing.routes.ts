import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requirePermission } from "../../middleware/requirePermission.js";
import { parseOrThrow, validateBody } from "../../middleware/validateBody.js";
import {
  generateInvoicesSchema,
  listInvoicesSchema,
  recordPaymentSchema,
  reportSchema,
  reversePaymentSchema,
  setRatesSchema,
} from "./billing.schemas.js";
import * as service from "./billing.service.js";

/** Maintenance rates, invoices, cash receipts and the reports built from them. Mounted at /api/v1. */
export function createBillingRouter() {
  const router = Router();
  const setRates = [requireAuth, requirePermission("BILLING_RATE_SET")];
  const generate = [requireAuth, requirePermission("INVOICE_GENERATE")];
  const takePayment = [requireAuth, requirePermission("PAYMENT_CASH_MARK")];
  // Reading what has been billed serves every billing panel, so any of them may list invoices
  const read = [
    requireAuth,
    requirePermission("INVOICE_GENERATE", "PAYMENT_CASH_MARK", "REPORT_VIEW"),
  ];

  router.get(
    "/societies/:societyId/billing-rates",
    ...read,
    async (req, res) => {
      res.json({
        data: await service.listRates(req.ctx!, req.params.societyId as string),
      });
    },
  );
  router.post(
    "/societies/:societyId/billing-rates",
    ...setRates,
    validateBody(setRatesSchema),
    async (req, res) => {
      res
        .status(201)
        .json({
          data: await service.setRates(
            req.ctx!,
            req.params.societyId as string,
            req.body,
          ),
        });
    },
  );

  router.get("/societies/:societyId/invoices", ...read, async (req, res) => {
    const query = parseOrThrow(listInvoicesSchema, req.query);
    res.json({
      data: await service.listInvoices(
        req.ctx!,
        req.params.societyId as string,
        query,
      ),
    });
  });
  /** Preview writes nothing: the same arithmetic the Generate button would run */
  router.post(
    "/societies/:societyId/invoices/preview",
    ...generate,
    validateBody(generateInvoicesSchema),
    async (req, res) => {
      res.json({
        data: await service.previewInvoices(
          req.ctx!,
          req.params.societyId as string,
          req.body,
        ),
      });
    },
  );
  router.post(
    "/societies/:societyId/invoices",
    ...generate,
    validateBody(generateInvoicesSchema),
    async (req, res) => {
      res
        .status(201)
        .json({
          data: await service.generateInvoices(
            req.ctx!,
            req.params.societyId as string,
            req.body,
          ),
        });
    },
  );

  router.get("/invoices/:invoiceId/payments", ...read, async (req, res) => {
    res.json({
      data: await service.listPayments(
        req.ctx!,
        req.params.invoiceId as string,
      ),
    });
  });
  router.post(
    "/invoices/:invoiceId/payments",
    ...takePayment,
    validateBody(recordPaymentSchema),
    async (req, res) => {
      res
        .status(201)
        .json({
          data: await service.recordPayment(
            req.ctx!,
            req.params.invoiceId as string,
            req.body,
          ),
        });
    },
  );
  router.post(
    "/payments/:paymentId/reverse",
    ...takePayment,
    validateBody(reversePaymentSchema),
    async (req, res) => {
      res.json({
        data: await service.reversePayment(
          req.ctx!,
          req.params.paymentId as string,
          req.body,
        ),
      });
    },
  );

  /** ?format=csv is the Download CSV button; the rows are identical either way */
  router.get(
    "/societies/:societyId/reports",
    requireAuth,
    requirePermission("REPORT_VIEW"),
    async (req, res) => {
      const query = parseOrThrow(reportSchema, req.query);
      const report = await service.runReport(
        req.ctx!,
        req.params.societyId as string,
        query,
      );
      if (query.format !== "csv") return res.json({ data: report });
      const filename = `${report.report.toLowerCase()}-${query.period ?? "all"}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      return res.send(service.toCsv(report.columns, report.rows));
    },
  );

  return router;
}
