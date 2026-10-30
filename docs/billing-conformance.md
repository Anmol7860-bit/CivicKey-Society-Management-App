# Billing rates and invoice generation — conformance

The story asks for approved maintenance rates, invoice generation for eligible flats, and a
resident view of their own bills. Most of it was already built by the earlier billing work. This
is what matches, what was fixed to match, and where the repository deliberately differs — with
the reason, because several of the differences are decisions the story itself defers to the BRD.

## §1 Business rules

| Rule | Status | Where |
| --- | --- | --- |
| `BILLING_RATE_SET`, `INVOICE_GENERATE`, `BILL_VIEW_OWN` | Done | `billing.routes.ts` |
| Committee billing permissions do not carry General Admin ones | Done | `COMMITTEE_PERMISSIONS` is a separate list from `GENERAL_ADMIN_PERMISSIONS` in `permissions.ts` |
| Everything scoped to the caller's society | Done | `loadSociety` / `loadInvoice` → `requireRecord` → `CROSS_SOCIETY_ACCESS` |
| A resident reaches only their own flat's bills | Done | `listMyInvoices` filters by a verified, in-date `flat_residents` row; `getInvoice` calls `assertFlatAccess` |
| No invented late fees, interest, proration, tax or carry-forward | Done | `priceInvoices` charges maintenance + sinking fund + parking + an explicit one-time line, nothing else. `late_fee_per_day` is stored when an Admin sets it and is never applied to an invoice |
| No duplicate invoice per flat and period | Done | unique `invoices_flat_id_period_unique`, plus `onConflictDoNothing` on the same target |
| Duplicate generation returns 409 `BILL_ALREADY_EXISTS` | **Fixed here** | it used to be a 400 `INVALID_STATE` |
| An issued invoice is never silently re-priced | Done | there is no invoice update path; `invoices.rate_id` names the rate version used, and `total` is a generated column over the stored components |
| Rate history preserved | Done | `setRates` only ever inserts; old rows stay |
| Generation and payment are separate | Done | `generateInvoices` never writes `payments` and never sets `PAID`; settlement happens only in `settleInFull` (cash or a verified webhook) |
| Retry-safe generation | Done | one transaction, and the unique constraint makes a replay a no-op rather than a double bill |
| `numeric`, never floating point | Done | money is carried in integer paise (`toPaise`/`fromPaise`) and written as a fixed two-decimal string into `numeric(10,2)` |

**Billing period.** The story's baseline is one calendar month "unless the BRD formally defines
another cycle". This society bills **quarterly** — 1 January, April, July and October, due fifteen
days later. That predates this story: `isQuarterStart`, the `invoices_period_is_quarter_start`
check constraint (migration 0030) and the quarter picker in the UI all encode it. Moving to months
would rewrite issued financial records, so it stays until the BRD says otherwise.

**Eligibility.** "Recommended default: use the approved occupancy/eligibility snapshot for the
target period." There is no occupancy snapshot table in this repository. Eligibility is therefore
*current* occupancy: active flats, with at least one verified resident whose assignment covers
today, or every active flat when the caller picks `flats: "ALL"`. A flat that cannot be priced
(per-sq-ft with no carpet area) is reported in `skipped`, never billed at zero. Building a
period-snapshot table is a schema decision for the BRD, not an assumption to make here.

**Currency and rounding.** INR only; there is no currency column and no multi-currency
requirement anywhere in the product. Rounding is to the paisa: amounts are converted to integer
paise with `Math.round` on input, all arithmetic is integer, and the result is written with
exactly two decimals. The API carries amounts as JSON numbers rather than decimal strings — the
`money()` validator rejects anything finer than a paisa, so no value is accepted that a number
cannot hold exactly. Changing the wire format would touch every billing screen for no behavioural
gain.

## §2 Endpoints

| Story | This repository | Status |
| --- | --- | --- |
| `GET /billing/rates` | `GET /societies/:societyId/billing-rates` | Done |
| `POST /billing/rates` | `POST /societies/:societyId/billing-rates` | Done |
| `PUT /billing/rates/{rateId}` | — | Not built, on purpose: see below |
| `POST /invoices/generate` | `POST /societies/:societyId/invoices` (+ `/preview`) | Done |
| `GET /invoices` | `GET /societies/:societyId/invoices`, `GET /me/invoices` | Done, **`page`/`limit` added here** |
| `GET /invoices/{invoiceId}` | `GET /invoices/:invoiceId` | **Built here** |

Paths are nested under the society because every other module in this API is, and the society is
still resolved from the trusted token, never from the path — a mismatch is a 403
`CROSS_SOCIETY_ACCESS`, which the tests cover.

**No rate update route.** The story's own recommended approach is "close the previous effective
period and create a new rate version", and that is exactly what `POST .../billing-rates` does: a
rate is versioned by `effective_from`, the one in force on a date is the newest that had already
taken effect (`rateOn`), and the previous version's period ends when the next begins. So there is
no `effective_to` or `status` column either — they would be derived data that could disagree with
the rows. A draft-rate lifecycle is not in the BRD, so there is nothing an update could edit that
would not change history.

**Read access to rates** is wider than `BILLING_RATE_SET`: any of the billing permissions may
list them, because the generate and payment panels show the rate they are about to apply.

**Generation is synchronous.** No `billing_job_runs`, `billing_job_items`, 202 or job id. One
run covers one society's active flats in a single transaction; the story asks for a job only "if
the operation is too large for a synchronous request". The retry-safety the job record exists to
provide is already given by the unique constraint. `idempotencyKey` and
`IDEMPOTENCY_KEY_REUSED` are not implemented for the same reason: the database key for a run is
(flat, period), and a replay of the same request creates nothing and reports
`BILL_ALREADY_EXISTS`. If a society ever grows past what one request can price, the job tables are
the upgrade — a schema change for the BRD, not an assumption.

## §3 Tables

`billing_rates` and `invoices` exist. `invoice_lines` does not: the story explicitly allows the
bundled shape — "if all charges are bundled into one invoice per flat/month, enforce one invoice
per flat/month instead" — and that is what this is. The components are columns
(`maintenance`, `sinking_fund`, `parking_charge`, `one_time_description` / `one_time_amount`),
`total` is `generated always as` their sum so no client can disagree with it, and `rate_id`
pins the version used. `GET /invoices/:invoiceId` presents those columns as line items, so the
detail view has the itemisation the story asks for without a second table to keep immutable.

Not present, for the reasons above: `invoice_lines`, `billing_job_runs`, `billing_job_items`,
`billing_rates.effective_to`, `billing_rates.status`, a `currency` column, `charge_type`.

## §4 Frontend

Built already, in `features/billing/` and `features/gate/BillsPage.tsx`: the rate list with the
current rate and a create form (effective-from with a hint, duplicate dates refused by the
server and surfaced), the generation form with a **Preview** that prices every flat and lists
what it had to skip before anything is written, the invoice list with period/flat/status filters,
and the resident's own bills with their receipts. Loading, empty and API-error states come from
the shared `useResource`/`Panel` parts.

Not built: a separate admin invoice-detail screen (the list row already carries total, paid,
outstanding and status), and a job-progress view, which has nothing to show while generation is
synchronous.

## §5 Errors

| Code | Status |
| --- | --- |
| 400 `VALIDATION_ERROR`, 401, 403 `PERMISSION_DENIED`, 403 `CROSS_SOCIETY_ACCESS`, 404 `NOT_FOUND` | Already shared across the API |
| 403 `NOT_YOUR_FLAT` | Done — `assertFlatAccess`, now reached by `GET /invoices/:invoiceId` |
| 409 `RATE_NOT_CONFIGURED` | **Added** (was 400 `INVALID_STATE`) |
| 409 `RATE_PERIOD_CONFLICT` | **Added** (was 409 `ALREADY_EXISTS`) |
| 409 `BILL_ALREADY_EXISTS` | **Added** (was 400 `INVALID_STATE`) |
| 422 `NO_ELIGIBLE_FLATS` | **Added** (was 400 `INVALID_STATE`) |
| 409 `IDEMPOTENCY_KEY_REUSED` | Not applicable — no idempotency key, see §2 |

A run that prices nothing now says which of the two it is: every candidate already invoiced is a
duplicate (409), anything else is an eligibility failure (422).

## §6 Tests

`backend/src/modules/billing/billing.test.ts` covers permissions per panel, rate history and the
rate in force on a quarter start, exact per-sq-ft arithmetic, eligibility (occupied vs all,
unpriceable flats), invoice uniqueness, a repeat run, the new error codes, pagination, the
invoice detail with its line items and payment summary, and a resident refused another flat's
invoice. Payment separation is covered in `payment.test.ts`: an invoice becomes `PAID` only
through a settlement.

Not covered: partial batch retry per flat (there is no per-flat job record to retry) and
cross-society access on billing specifically — `requireRecord` is the shared gate and is tested
where it lives.
