import { z } from "zod";
import { chargeBasis } from "../../db/schema.js";

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD");
/** The month billed, as YYYY-MM; the database stores its first day */
const period = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use the format YYYY-MM");
/** Rupees, to the paisa. Sent as a number and stored as numeric, never as a float in the database. */
const money = (max = 1_000_000) =>
  z
    .number()
    .min(0)
    .max(max)
    .refine(
      (value) =>
        Number.isFinite(value) && Math.round(value * 100) === value * 100,
      {
        message: "Give an amount in rupees and paise",
      },
    );

export const setRatesSchema = z.strictObject({
  chargeBasis: z.enum(chargeBasis.enumValues),
  /** Per sq ft of carpet area, or per flat, depending on the basis */
  rate: money().refine((value) => value > 0, {
    message: "The rate must be more than zero",
  }),
  sinkingFund: money().optional(),
  parkingCharge: money().optional(),
  /** Capped at 28 so every month has the day */
  dueDay: z.number().int().min(1).max(28),
  lateFeePerDay: money(10_000).nullable().optional(),
  effectiveFrom: isoDate,
});

export const generateInvoicesSchema = z
  .strictObject({
    period,
    /** Which flats to bill: every occupied flat, or every active flat including the empty ones */
    flats: z.enum(["OCCUPIED", "ALL"]).optional(),
    oneTimeDescription: z.string().trim().min(2).max(120).optional(),
    oneTimeAmount: money().optional(),
  })
  .refine(
    (body) => !body.oneTimeAmount || body.oneTimeDescription !== undefined,
    {
      message: "Describe what the one-time charge is for",
      path: ["oneTimeDescription"],
    },
  );

export const listInvoicesSchema = z.strictObject({
  period: period.optional(),
  flatId: z.uuid().optional(),
  status: z.enum(["UNPAID", "PARTIALLY_PAID", "PAID", "CANCELLED"]).optional(),
});

export const recordPaymentSchema = z.strictObject({
  amount: money().refine((value) => value > 0, {
    message: "The amount must be more than zero",
  }),
  receivedOn: isoDate,
  paidBy: z.string().trim().min(2).max(120).optional(),
  note: z.string().trim().min(1).max(200).optional(),
});

export const reversePaymentSchema = z.strictObject({
  reason: z.string().trim().min(3, "Give a reason").max(200),
});

/** The reports panel: what to report on, and over which period */
export const reportSchema = z.strictObject({
  report: z.enum(["COLLECTIONS", "OCCUPANCY"]),
  period: period.optional(),
  format: z.enum(["json", "csv"]).optional(),
});

export type SetRatesBody = z.infer<typeof setRatesSchema>;
export type GenerateInvoicesBody = z.infer<typeof generateInvoicesSchema>;
export type ListInvoicesQuery = z.infer<typeof listInvoicesSchema>;
export type RecordPaymentBody = z.infer<typeof recordPaymentSchema>;
export type ReversePaymentBody = z.infer<typeof reversePaymentSchema>;
export type ReportQuery = z.infer<typeof reportSchema>;
