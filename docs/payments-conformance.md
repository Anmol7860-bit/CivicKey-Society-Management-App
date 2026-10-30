# Resident payments, webhooks and receipts — conformance

The story asks residents to pay an issued invoice, have the result verified by the provider
rather than by the browser, and get a receipt only once success is confirmed. Most of it was
built with the gateway work. This is what matches, what was added to match, and where the
repository deliberately differs.

## §1 Business rules

| Rule | Status | Where |
| --- | --- | --- |
| A resident pays only their own flat's issued invoice | Done | `startCheckout` → `assertFlatAccess(..., { write: true })`; a VIEW_ONLY member is refused |
| `BILL_PAY` to pay, `RECEIPT_VIEW_OWN` to see receipts | Done | `billing.routes.ts` |
| The redirect is never proof of payment | Done | the browser's return changes nothing; the bills page now asks the server (`confirmedState`) and only says "confirmed" when the server says `SUCCESS` |
| Provider idempotency and unique provider references | Partly — see below | `payment_attempts.provider_order_id` is unique, `gateway_events` is unique on (provider, event id) |
| Signature verified before the payload is trusted | Done | `signatureMatches` over the raw bytes, timing-safe; the raw body parser is registered for that path before the JSON parser |
| A duplicate webhook cannot pay twice | Done | the event id insert is `onConflictDoNothing`, a repeat returns `{ handled: false, reason: 'DUPLICATE' }`; the partial unique index `payment_attempts_one_success_per_invoice` and `receipts.payment_id` make a second settlement impossible even if it got that far |
| A receipt only after confirmed success | Done | `issueReceipt` runs inside `settleInFull`'s transaction, which is reached only from a verified webhook or an audited cash entry |
| No card numbers, CVV, UPI PIN or bank credentials stored | Done | hosted checkout; the server never sees them. **Fixed here:** the stored webhook row used to be the gateway's whole payload, which carries the payer's email, phone and card last four. Only the five fields the settlement is checked against are written now (`verifiedFacts`) |
| No invented refunds, partial payments, fees or allocation | Mostly — see below | `settleInFull` refuses anything but the exact outstanding amount |
| Cash marking needs `PAYMENT_CASH_MARK`, with actor and timestamp | Done | `recordPayment` stores `recorded_by`, `received_on` and an optional `paid_by`/`note`, and audits `PAYMENT_RECORDED` |
| Financial changes transactional and auditable | Done | one transaction per settlement, each with its audit row |

**Reversal.** `POST /payments/:paymentId/reverse` already exists: an Admin with
`PAYMENT_CASH_MARK` marks a payment reversed with a reason, which puts the invoice back to
`UNPAID` and is audited as `PAYMENT_REVERSED`. It is a cash-desk correction (a cheque bounced, a
payment keyed against the wrong flat), not a gateway refund — no money moves, and the attempt
stays `SUCCESS`. The story says refunds and chargebacks need BRD approval, so nothing was built
on top of it; it is recorded here because it is the one way an invoice can leave `PAID`.

**Provider adapter.** `gateway.ts` is the whole provider surface: `createOrder`,
`signatureMatches`, `checkoutConfigured`. Nothing else in the module talks to Razorpay except
`apply()`, which reads the Razorpay event shape. A second provider means a second module and a
second `apply`, which is the seam the story asks for; an interface with one implementation behind
it would not add one.

## §2 Lifecycle

`payment_attempts.status` runs `INITIATING → CREATED → SUCCESS | FAILED | REVIEW_REQUIRED`,
which maps to the story's states as `INITIATING` = INITIATED and `CREATED` = PENDING (the order
exists at the gateway; nothing is verified). The enum also carries an unused `PENDING` value.

`SUCCESS` is terminal: the `payment.failed` update carries `where status <> 'SUCCESS'`, and only
one attempt per invoice may ever hold it. An amount that does not match leaves the attempt
`REVIEW_REQUIRED` with the invoice unpaid and an audit row for an operator to find.

## §3 Endpoints

| Story | This repository | Status |
| --- | --- | --- |
| `POST /payments` | `POST /invoices/:invoiceId/checkout` | Done; **a second click now reopens the order already waiting instead of creating another** |
| `GET /payments/{paymentId}` | `GET /payments/:paymentId` | **Built here** |
| `POST /payments/webhooks/{provider}` | `POST /payments/razorpay/webhook` | Done |
| `POST /payments/cash` | `POST /invoices/:invoiceId/payments` | Done, `PAYMENT_CASH_MARK` only |
| `GET /receipts/{receiptId}` | `GET /receipts/:receiptId` (+ `/pdf`) | **Built here** |

**No `method` in the request.** Razorpay's hosted window offers the resident every method the
merchant account has enabled, and the choice is made there, not here. There is no approved method
list in the BRD to validate against, so none is invented.

**No client `idempotencyKey`.** Initiation is made idempotent server-side instead: an open
`CREATED` attempt for the same invoice and the same outstanding amount is returned again rather
than a second gateway order being created. That covers the double-click and the resident who
closes the window and comes back, without a key the frontend has to invent and store. The amount
is part of the match, so a part-settled invoice correctly starts a fresh attempt.

**Amount is never taken from the request.** `startCheckout` reads the invoice total, subtracts
what has been paid, and sends that to the gateway as the order amount; the webhook must capture
exactly that number, in INR, or the attempt goes to `REVIEW_REQUIRED`.

## §4 Database

| Story table | This repository |
| --- | --- |
| `payments` with status and provider columns | split in two: `payment_attempts` holds the gateway lifecycle (amount in paise, status, `provider_order_id` unique, `provider_payment_id`, `started_by`, failure reason), `payments` holds settled money only (amount `numeric(10,2)`, `received_on`, `recorded_by`, receipt number, reversal fields) |
| `payment_webhook_events` | `gateway_events` — provider, `provider_event_id` (unique with provider), event type, minimal payload, `received_at`, `handled_at`, `result` |
| `receipt_sequences` | the Postgres sequence `receipt_number_seq`, read in the column default, so two settlements can never share a number |
| `receipts` | `receipts` — one per payment (`payment_id` unique), number, status, rendered PDF file id |

Money is `numeric(10,2)` in `payments` and integer paise in `payment_attempts`; nothing is a
float. Currency is INR throughout and is not a column — there is no second currency anywhere in
the product, and the webhook refuses anything else.

Deliberately not added, because each would be a schema change to financial tables on an
assumption: a `payment_id` link and a `safe_error_code` column on `gateway_events` (the result
string and the attempt's `failure_reason` already carry both), `idempotency_key`, `method`,
`provider` and `currency` columns on `payments`.

## §5 Frontend

The resident's bills page shows the bill broken into its parts, pays only when something is
outstanding and the user holds `BILL_PAY`, hands off to the gateway's own window, and — **added
here** — asks the server what it verified once that window closes, showing "checking with the
bank", then the confirmed result or the existing "the receipt appears once your bank confirms"
line. It never reports success from the browser's return. The pay button is disabled while the
action is in flight, so a double-click cannot start two payments, and the server would return the
same attempt anyway.

Not built: a method picker (there is nothing to pick between before the gateway's own window), a
retry button (the Pay button is the retry, and it reopens the waiting order), and a provider-
cancellation state distinct from pending — the gateway tells the browser nothing trustworthy
about a cancellation, so it is reported as "not confirmed" like any other unverified outcome.

## §6 Errors

| Code | Status |
| --- | --- |
| 401, 403 `PERMISSION_DENIED`, 403 `NOT_YOUR_FLAT`, 403 `CROSS_SOCIETY_ACCESS`, 404 `NOT_FOUND` | Already shared across the API; `NOT_YOUR_FLAT` now also guards `GET /payments/:id` and `GET /receipts/:id` |
| 409 `INVOICE_NOT_PAYABLE` | **Added** (cancelled invoice; was 400 `INVALID_STATE`) |
| 409 `PAYMENT_ALREADY_SUCCESSFUL` | **Added** (already paid, or nothing outstanding) |
| 400 `WEBHOOK_SIGNATURE_INVALID` | **Added** (was 401 `TOKEN_INVALID`) |
| 409 `PAYMENT_AMOUNT_MISMATCH` | Added as a code, not as a response: a mismatched capture answers the gateway 200 and leaves the attempt `REVIEW_REQUIRED`, because a 4xx only makes the gateway redeliver something that will never apply |
| 409 `WEBHOOK_EVENT_ALREADY_PROCESSED` | Acknowledged as 200 `{ handled: false, reason: 'DUPLICATE' }`, which is what the story asks for in prose — an idempotent acknowledgement that stops the retries |
| 409 `IDEMPOTENCY_KEY_REUSED` | Not applicable — no client key, see §3 |
| 503 provider unavailable | Done for a missing configuration (`PAYMENT_NOT_CONFIGURED`) and 502 `PAYMENT_GATEWAY_ERROR` when the order call fails; the attempt is marked `FAILED` with the reason rather than lost |

**Reconciliation.** A capture for an order this society never started is recorded in
`gateway_events` with `result = 'IGNORED'` and nothing is paid. There is no operator alert and no
poller that asks the gateway about attempts stuck at `CREATED`; the row is the record, and an
Admin reads it. <!-- ponytail: a nightly reconciliation job against the gateway's orders API is
the upgrade when stuck attempts are seen in practice. -->

## §7 Tests

`payment.test.ts` covers initiation and the amount asked for, duplicate initiation, an invoice
that is settled or cancelled, missing gateway configuration, a valid webhook settling exactly
once with one receipt, a retry of the same event, an invalid signature, a short capture left for
review, a gateway failure, an event for an unknown order, the verified status endpoint and a
resident refused another flat's payment, the redacted stored payload, the receipt detail and a
resident refused another flat's receipt. 33 tests across the billing module pass.

Not covered: out-of-order delivery of `payment.failed` after `payment.captured` (the status guard
is asserted only in the other direction) and a real provider integration test, which needs
credentials and a tunnel.
