# Solution Design v4.0 — conformance and gaps

Compared against the Google Doc "Society Management Solution Design — Technical Solution
Design v4.0" (14 stories) on 2026-11-02. Story 2 has its own deeper write-up in
[rbac-conformance.md](rbac-conformance.md); this file covers the other thirteen and the global
rules, and records only what was checked in the code, not what was assumed.

Nothing here is a to-do list. It is a record of where the build and the baseline differ, so the
difference is a decision rather than a surprise.

## Global rules (section 1)

| Rule | State |
| --- | --- |
| Phone + password, no OTP/SMS | matches |
| Access token 30 min, rotating refresh 30 days | matches |
| Refresh token only in an HttpOnly, SameSite=Strict cookie scoped to `/api/v1/auth` | matches (`auth.routes.ts`, asserted in `login.test.ts`) |
| Guard session capped at 12 hours | **not implemented** — a Guard session expires on the same 30-day refresh clock as everyone else |
| Login throttling in PostgreSQL by phone and IP, 5 failures → 15-minute phone lock, 30 requests/IP/15 min | matches (`auth_rate_limit_buckets`, `throttle.ts`) |
| Timestamps TIMESTAMPTZ in UTC | matches |
| Government ID AES-256-GCM + keyed HMAC lookup, masked to last 4 | matches (`modules/access/identity.ts`) |
| Outbox written inside the business transaction; dispatcher polls, retries, marks DEAD | matches (`notification_outbox`, `notification_deliveries`, `dispatcher.ts`) |
| Email only for RECEIPT_READY / BILL_DUE_SOON / BILL_OVERDUE, through Brevo | matches (`channels.ts`, `EMAIL_EVENTS`) |
| Local encrypted pg_dump backup, 15-minute download link, audited | matches (`backup.service.ts`, `LINK_TTL_MS`) |
| Error contract 400/401/403/404/409/422/429 | matches in shape; cross-society access answers **403 `CROSS_SOCIETY_ACCESS`** where the baseline asks for 404 |

## Story 1 — Authentication

Built: `POST /auth/login` (with portal/role check → 403 `ROLE_MISMATCH`), `/auth/refresh`
(rotation, reuse revokes the family), `/auth/logout`, `/auth/permissions`, plus
`/auth/forgot-password` and `/auth/set-password`.

Gaps against the baseline:

- **No `GET /auth/me`.** The frontend reads the profile from the login/refresh payload instead.
  Scenario AUTH-12 has nothing to test.
- **No `POST /auth/change-password`,** and no `must_change_password` /
  `temporary_password_expires_at` on `users`. Scenarios AUTH-13 and AUTH-14 (first login with a
  temporary password; Admin reset handing over a temp password) are not implemented as written.
- **Different onboarding model.** Instead of a 12-character temporary password, the office issues
  a 4-digit one-time code (`password_setup_codes`, 72-hour TTL, 5 attempts, phone-scoped) which
  the user spends at `/auth/set-password`. This is a deliberate divergence, decided in this
  project; it is not what the document specifies.
- **No `POST /users` provisioning endpoint.** Users are created through
  `POST /flats/:flatId/residents` (resident), `POST /societies/:id/admins` (Admin) and
  `POST /staff/:id/account` (guard).
- Session table is `auth_sessions`, not `user_sessions`; the refresh family and
  `replaced_by_token_id` chain behave as specified.

## Story 3 — Offline support

Built and close to the baseline: `POST /sync/events`, `processed_client_events` keyed by
`client_event_id`, per-event results, IndexedDB queue on the client (`features/sync/db.ts`,
`queue.ts`, `useSync.ts`), `GET /sync/needs-review`, cached-pass handling (`cache.ts`).

- Result enum matches (`APPLIED`, `DUPLICATE_IGNORED`, `FAILED_RETRY`, `REJECTED`,
  `NEEDS_REVIEW`) plus an extra `IN_PROGRESS` claim state the document does not describe.
- Worth confirming against the baseline, not verified in this pass: the 50-event batch cap, the
  10-attempt → NEEDS_REVIEW rule, and the >24-hour clock-skew rule.

## Story 4 — Society, block & flat

Built: society CRUD, blocks, flats, gates, settings, occupancy, deactivation rather than delete.

- **Extra level: `floors`.** The document models societies → blocks → flats. The build inserts a
  floors table between blocks and flats, with its own routes. This is a structural divergence from
  the ERD in section 16.1.
- **`flats.carpet_area_sqft` is a nullable `integer`;** the baseline requires
  `sqft NUMERIC(10,2) NOT NULL CHECK (sqft > 0)`. The check exists but only as
  "null or > 0". A flat with no area recorded is therefore possible, which is the condition
  scenario BILL-05 is about.
- No `npm run bootstrap:society` command as described in the story; the society is seeded.

## Story 5 — Resident & tenant

Built: `flat_residents` with owner/tenant, access level, date bounds, partial unique indexes,
`syncOwnerAccess` restoring owner FULL access in the move-out transaction.

- **`flat_residents` carries a `verification_status`** (PENDING / VERIFIED / REJECTED) and a
  reject reason. The baseline says explicitly "flat_residents has no status column" — registration
  there is immediate and only dates govern activity. The build adds an approval queue in front of
  it (the Approvals tab). Divergence by design, but it changes RES-01/RES-04 semantics.
- Pending-approval hand-over on tenant change: the visit's `reminder_at`/`escalate_at` are
  preserved as the baseline requires, but because there is no `approval_requests` table there is no
  `SUPERSEDED` row to record who the request used to belong to (see Story 8).

## Story 6 — Guard & staff

Built: `staff`, `staff_flats` (date-bounded assignments), guard accounts via
`POST /staff/:id/account`, `guard_profiles`, `guard_gate_assignments`, verification states,
block/leave, ID encryption, `stored_files` for photos.

- **No `staff_passes` table.** A pass is a single `staff.pass_code` column: one code per staff
  member, with no `valid_from`/`valid_to`, no status, no per-pass revoke, no 365-day cap. GST-05
  ("revoke all active passes in one transaction") and the pass-expiry half of STAFF-02 have no
  representation.
- **Staff photo is not mandatory** at the schema level; the baseline makes `photo_path` NOT NULL.
- Resident-managed daily help exists (`/me/daily-help`), matching `STAFF_MANAGE_OWN` in spirit;
  the permission code itself was folded into `VISIT_VIEW_OWN` (see rbac-conformance.md).

## Story 7 — Visitor registration

Built: `POST /societies/:id/visits`, gate/flat scope, pass fast path, offline source
(`MANUAL_OFFLINE`, `needs_review`), visitor lookup, vehicle lookup, visit purposes.

- **No `visitors` identity table.** Name and phone live on the visit as snapshots only. The
  baseline wants a normalized `visitors` row unique by (society, phone) carrying the encrypted ID
  and lookup digest; VIS-07's "exact lookup by keyed digest" has nothing to look up against.
- **No `blocked_visitor_phones` table and no `VISITOR_BLOCK_MANAGE` permission.** Scenario VIS-10
  (403 `VISITOR_BLOCKED`) is entirely absent.
- **No `visit_events` append-only history table.** State changes are recorded in `audit_logs`
  plus timestamp columns on `visits`. The ERD's visits → visit_events 1:N is not built, so
  "append VISITOR_EXITED then VISIT_CLOSED events" (GATE-05) is approximated by `exited_at` and
  the CLOSED status.
- Visit status enum adds `LEAVE_AT_GATE`, `CANCELLED` and `REJECTED_AT_GATE` beyond the six the
  baseline fixes. These are real product behaviours but they are outside the documented state
  machine.

## Story 8 — Visitor approval & pre-approval

Built: resident decision at `POST /visits/:id/decision`, pass creation at
`POST /flats/:flatId/passes`, pass validation, revoke, the 60-second reminder job and the
180-second escalation job (`notification/jobs.ts`, `visits_escalation_idx`).

- **No `approval_requests` table.** `reminder_at`, `escalate_at`, `reminder_sent_at`, `decided_by`
  and `decided_at` are columns on `visits`. Consequences: there is no `PENDING` /
  `SUPERSEDED` / `TIMED_OUT` request lifecycle, no `requested_to_user_id` recipient row, no
  `uq_one_pending_approval_per_visit`, and no history of a re-pointed approver (APR-11).
- **No `visitor_pass_groups`.** The group/event invitation flow (APR-09) is not built; passes are
  individual.
- Timers themselves match: one reminder at 60s, escalation to `AWAITING_MANUAL` at 180s, no
  automatic allow or deny.

## Story 9 — Gate entry & exit

Built: `/visits/:id/entry`, `/exit`, `/gate-rejection`, `/leave-at-gate`, `/cancel`, gate log,
gate summary, "inside" list. Conditional-update concurrency and the 409 paths are in place.

Gap: the `visit_events` history table above. Entry/exit actors, gates and timestamps are stored
as columns on `visits`, so a visit keeps only its latest entry and exit, not an event stream.

## Story 10 — Staff movement & verification

Built on `staff_attendance` (one open row per staff member, enforced by a partial unique index),
with `/staff/:id/entry`, `/exit`, `/movement/entry-rejection`, `staff_entry_rejections`,
`/societies/:id/staff-movements`, `/staff-inside`.

- **No `staff_house_visits` table, and no resident ARRIVED / LEFT actions.** The baseline calls
  household visit tracking "enabled in the MVP" with PENDING → ARRIVED → LEFT and
  `NOT_CONFIRMED_BY_RESIDENT` at gate exit. Scenario STAFF-08 is not implemented at all, and
  neither is the destination-flat choice at entry that it depends on.
- `staff_movements` as named in the document does not exist; `staff_attendance` is its equivalent
  and was a deliberate decision recorded earlier in the project.

## Story 11 — Real-time notifications

The closest match in the whole document. `notification_outbox` with unique event key,
`notification_deliveries` per channel, `push_subscriptions`, Socket.IO rooms derived server-side,
Brevo limited to the three approved events, dispatcher with claim/retry/DEAD.

Not verified in this pass: the exact retry ladder (30s/2m/10m/1h), the 5-minute stale-claim
reclaim, and 404/410 push subscription cleanup.

## Story 12 — Maintenance billing

Built: `billing_rates` effective-dated, quarterly period codes validated to Jan/Apr/Jul/Oct, due
date = quarter start + 15 days, invoice preview, generation, per-flat results, defaulter and
collection reports.

- **No `invoice_lines` table.** An invoice stores component columns (maintenance, sinking,
  parking, one-time) instead of lines with `sqft_snapshot` and `rate_snapshot`. The calculation
  inputs the baseline wants persisted for traceability are not stored per line.
- **No `billing_job_runs` / `billing_job_items`.** Scenario BILL-03 (rerun a FAILED/PARTIAL run,
  per-flat `CREATED` / `ALREADY_EXISTS` / `SKIPPED_NO_RATE` / `SKIPPED_INVALID_SQFT` items) and
  BILL-04 (run marked FAILED until a rate is supplied) have no persistent record to work against.
- **Invoice status enum differs:** `UNPAID, OVERDUE, PARTIALLY_PAID, PAID, CANCELLED` versus the
  baseline's `UNPAID, OVERDUE, PAID, VOID`. `PARTIALLY_PAID` directly contradicts "partial
  settlement disabled".
- One-time charges are fields on an invoice, not separate `ONE_TIME` invoices with an idempotency
  key per flat as BILL-06 describes.

## Story 13 — Payments & receipts

Built: Razorpay hosted checkout, `payments`, `payment_attempts`, `gateway_events` for webhook
dedupe, webhook signature verified with HMAC-SHA256 over the raw body using `timingSafeEqual`,
cash marking, receipts with `PENDING_PDF` → `READY` → `FAILED` and asynchronous PDF.

- **Receipt numbering is a global Postgres sequence** (`RCT-YYYY-000001`), not the
  `receipt_sequences(society_id, fiscal_year)` counter the baseline specifies, so numbering is
  not per-society and not per fiscal year.
- `gateway_events` stands in for `payment_webhook_events`; verify it carries the payload hash and
  processing status the baseline asks for.
- Not verified in this pass: the `REVIEW_REQUIRED` mismatch path (PAY-06) and the
  reconciliation worker for CREATED payments older than 15 minutes (PAY-10). A related known
  defect: the `payment_attempts` enum value `PENDING` is defined but never set.

## Story 14 — Community tasks & reports

Built: `community_tasks`, task CRUD, status changes, history endpoint, due/overdue reminder
stamps, `/societies/:id/reports`, `/task-summary`.

- **Status machine differs:** `OPEN, IN_PROGRESS, DONE, CANCELLED` versus the baseline's
  `OPEN → ASSIGNED → IN_PROGRESS → COMPLETED → CLOSED`. There is no ASSIGNED state and no
  separate COMPLETED/CLOSED pair, so TASK-03 and TASK-05 cannot pass as written.
- **Assignee model differs:** `assigned_staff_id` points at a staff record. The baseline fixes the
  assignee as an active same-society *user* or an Admin-held external name/contact.
- **No `task_status_history` and no `task_comments` tables.** `GET /tasks/:id/history` is served
  from audit logs rather than a status-history table, and comments are a single `closing_note`.

## Summary — what is not implemented at all

1. Resident ARRIVED / LEFT household visit tracking (Story 10, called MVP-required).
2. Blocked visitor phone list and `VISITOR_BLOCK_MANAGE` (Story 7, VIS-10).
3. Visitor pass groups / event invitations (Story 8, APR-09).
4. `GET /auth/me`, `POST /auth/change-password`, and the temporary-password onboarding
   (Story 1, AUTH-12 to AUTH-14).
5. The 12-hour Guard session cap (global rule, AUTH-01).
6. Billing job run/item records (Story 12, BILL-03/BILL-04).
7. Staff passes as time-bound revocable records (Story 6).

## Summary — built differently on purpose

Four-digit setup codes instead of temporary passwords; a floors level between blocks and flats;
resident registrations that wait in an approval queue; staff attendance instead of staff
movements; invoice component columns instead of invoice lines; approval timers on the visit
instead of an approval-request row. Each is a working behaviour; none of them is what the
baseline document says, and section 16.2 asks that a divergence be a versioned change rather than
a silent one.
