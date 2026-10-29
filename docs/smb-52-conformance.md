# SMB-52 — Real-time notifications

Covers §1–7 as given (objective, scope, events, recipient rules, solution design, backend logic,
idempotency). An audit of what already stands, plus the gaps it turned up. It will grow as the
later sections arrive.

## §1 Objective — the boundary holds

The module "shall not independently approve visitors, record gate entry/exit, or perform staff
verification". It does not: `enqueueNotification` only writes an outbox row, and it takes the
caller's executor, so the event commits with the change it describes.
Nothing in `backend/src/modules/notification/` reads or writes `visits` state, attendance, or a
staff verification. The dispatcher turns rows into messages and nothing else.

## §2 Scope — what is already built

| In scope | Status | Where |
| --- | --- | --- |
| Real-time application notifications | Done | `realtime.ts`, Socket.IO on `/api/v1/socket.io` |
| Visitor approval notifications | Done | `VISITOR_WAITING_APPROVAL` |
| Visitor approval decision notifications | Done | `VISITOR_DECIDED` |
| Visitor timeout / no-response | Done | `VISITOR_APPROVAL_REMINDER`, `VISITOR_ESCALATED_TO_GATE`, raised by `jobs.ts` |
| Gate entry/exit notifications | Done | `VISITOR_ENTERED`, `VISITOR_EXITED` |
| Staff / security-related | Done | `STAFF_ENTERED`, `STAFF_EXITED`, `OFFLINE_EVENT_NEEDS_REVIEW` |
| Notification read/unread state | Done | `notifications.read_at`, `markRead`, `unreadCount` |
| Web Push where supported | Done | `push.service.ts`, VAPID, a dead subscription is deactivated on a permanent failure |
| Socket.IO real-time delivery | Done | `SOCKET` channel; live-only, never retried, because the in-app record is the durable copy |
| Notification persistence | Done | `notifications` + `notification_deliveries` |
| Retry-safe delivery | Done | outbox with `FOR UPDATE SKIP LOCKED`, a stale-claim takeover, backoff 30s/2m/10m/1h then `DEAD` |
| User/society/role-based recipient validation | **Fixed here** | see below |
| Notification history | Done | `GET /notifications`, newest 50 |
| Notification delivery status | Partly | a row per channel with `status`, `attempts` and `last_error` exists; nothing surfaces it to an operator yet |
| Security and audit logging | Partly | rooms are derived from the verified token and a join request is never honoured; the module writes no audit row of its own |

## §3 Events — the names already in use

The subtask says these types "may be supported" and that the list "should remain configurable
rather than hard-coded throughout the frontend". The deployment's enum was built first and uses
its own names; they are not renamed, because the UI never switches on the type — the server
sends each notification's `title` and `body` already written, and the frontend's union is a
type only. Renaming twenty enum values across a migration, the dispatcher and the outbox would
change no behaviour.

| §3 event | Built as | Note |
| --- | --- | --- |
| VISITOR_APPROVAL_REQUESTED | `VISITOR_WAITING_APPROVAL` | to the eligible approvers of the flat |
| VISITOR_APPROVED | `VISITOR_DECIDED`, payload `status: APPROVED` | one event, the decision in the payload |
| VISITOR_DENIED | `VISITOR_DECIDED`, payload `status: DENIED` | same |
| VISITOR_TIMED_OUT | `VISITOR_ESCALATED_TO_GATE` | raised by the escalation job, plus `VISITOR_APPROVAL_REMINDER` one step earlier |
| VISITOR_PRE_APPROVED | **Not built** | see below |
| VISITOR_ENTRY | `VISITOR_ENTERED` | |
| VISITOR_EXIT | `VISITOR_EXITED` | |
| VISITOR_ENTRY_REJECTED | **Added here** | was folded into `VISITOR_DECIDED`; see below |
| STAFF_VERIFICATION_REQUIRED | **Not built** | see below |
| STAFF_MOVEMENT_EVENT | `STAFF_ENTERED` / `STAFF_EXITED` | split in two, which is what the recipient actually needs to read |
| SYSTEM_NOTIFICATION | **Not built** | `OFFLINE_EVENT_NEEDS_REVIEW` is the only system-level notice there is a rule for |

## §4 Recipient rules

> The notification service must never determine recipient eligibility only from frontend
> information.

It never sees frontend information at all. A recipient list is resolved server-side by the
service that raised the event — `flatAudience` for a visit, the flat's eligible approvers for an
approval, the staff member's flats for a movement — and the request body has no recipient field
on any route. The dispatcher then re-checks what it can:

| Must validate | Where |
| --- | --- |
| authenticated user | `requireAuth` on every route; the socket handshake verifies the access token and reads the society from the database, not the token |
| role | `requirePermission`; recipients are resolved from role-derived relationships, never named by a caller |
| society | `fanOut` requires `users.society_id = event.society_id` — added in this pass |
| flat / household relationship | `flatAudience` selects VERIFIED, in-period residents of that flat only |
| event ownership / scope | every read route is scoped to `req.ctx.userId`; there is no way to ask for another person's notifications |
| active account status | `fanOut` requires `users.is_active`; the socket handshake refuses an inactive account |

## §5 Solution design — one deliberate divergence

The flow matches: business event → handler → validate → resolve recipients → create notification
→ realtime, else persist and retry → read → mark read. One difference, on purpose.

The flowchart branches on "real-time channel available?" and persists only when it is not. The
build **always persists first**, then attempts the socket as one channel among four. A person
who is connected and a person who is not end up with the same durable record, and a socket that
drops mid-delivery cannot lose the notification. The `SOCKET` channel is marked sent without
retry, because a reconnecting client reads the persisted list instead.

## §6 Backend logic

### §6.1 Event creation

The chain in the example is the chain in the code. A resident approving a visitor runs
`decideVisit` in `gate.service.ts`: the visit moves to `APPROVED`, and only then
`enqueueNotification` writes one `notification_outbox` row naming the society, the event type,
the entity and the recipients the *calling* service resolved. The notification module is never
asked whether the approval should happen; it is told that it did.

`enqueueNotification(executor, event)` takes the executor rather than reaching for `db` itself,
so the caller hands it the transaction that made the change and both commit together. Every
call site now does: `registerVisit`, `decideVisit`, `cancelVisit`, `rejectVisitAtGate`,
`recordLeaveAtGate`, `recordCollection`, `recordEntry`, `recordExit`, the two staff movements,
`billing.service.ts`, `receipt.service.ts`, and the reminder, escalation and task-deadline jobs.
The audit row for each of those actions was moved inside the same transaction, for the same
reason: a killed process no longer leaves a visit nobody was told about, or a notification about
a visit that was never written.

Three details that shaped how it was done:

- **The claim is the transaction.** The jobs claim their work with the update that stamps
  `reminder_sent_at` or moves the status, and that claim is now inside the transaction that
  enqueues. A second runner blocks on the claimed rows and then matches none, which is what it
  did before; the difference is that a crash now un-claims the work instead of losing the notice.
- **A conditional update that matches nothing returns `null`,** and the `409` is thrown outside
  the transaction (`recordEntry`, `recordExit`), so the losing request still reads the current
  state to report it.
- **`recordLeaveAtGate` puts the transaction inside the code retry,** not around it. A collection
  code collision aborts its own transaction and the next attempt opens a fresh one; a retry
  inside a poisoned transaction would fail on every statement.

One call site keeps the bare `db` handle on purpose: `billReminders` in `jobs.ts` makes no other
write — the notice *is* the change — so there is no transaction to join. A second run on the same
day is stopped by the same-day outbox check above it, not by a transaction.

### §6.2 Notification processing

Every numbered step exists, in this order, in `dispatcher.ts`.

| §6.2 step | Where |
| --- | --- |
| 1. Receive validated application event | `claimOutbox()` — `FOR UPDATE SKIP LOCKED`, oldest first, `BATCH` of 50 |
| 2. Check event type | `describe(eventType, payload)`, an exhaustive switch over the enum |
| 3. Identify society | `event.societyId`, carried on the outbox row |
| 4. Resolve eligible recipients | resolved by the raising service (§4); the row carries the list |
| 5. Validate recipient access | `fanOut` re-queries `users` for `is_active` **and** `society_id = event.society_id` |
| 6. Create notification record | one `notifications` row per surviving recipient, in one transaction |
| 7. Generate delivery ID | one `notification_deliveries` row per channel, each with its own `uuid` primary key |
| 8. Attempt real-time delivery | `SOCKET` channel → `emitToUser` |
| 9. Optionally trigger Web Push | `PUSH` channel, `PENDING` only when the person has a live subscription, else `SKIPPED` |
| 10. Record delivery status | `status`, `attempts`, `last_error`, `sent_at`, `next_attempt_at` per channel |
| 11. Keep available for later retrieval | `GET /notifications`, unread count, `markRead` |

Step 5 is read narrowly, on purpose. The dispatcher checks what it can know without knowing the
business: the account is live and belongs to the society the event is about. It does not
re-derive whether that person is entitled to hear about *this flat's* visitor — doing so would
put the flat/household rule in the delivery layer, which §1 forbids. That rule lives in
`flatAudience` and `approverFor`, where the event is raised.

## §7 Idempotency — already enforced at the database

`notifications` carries `unique('notifications_outbox_user_unique').on(outbox_id, user_id)`, and
`fanOut` inserts with `onConflictDoNothing()`. The recommended key maps one-for-one:

| §7 key part | Column |
| --- | --- |
| `event_id` | `notifications.outbox_id` — the outbox row *is* the application event |
| `recipient_user_id` | `notifications.user_id` |
| `notification_type` | implied: `event_type` is a column of the outbox row, so one row has exactly one type |

Reprocessing is therefore a no-op rather than a duplicate: the retried insert conflicts, the
loop skips that recipient, and no second set of delivery rows is written. Covered by "does not
tell the same person twice when a row is fanned out again", which puts a fanned-out row back to
`PENDING` and runs the dispatcher again.

Duplicate *business* events — the same real action raising two outbox rows — are stopped one
level up, by each producer rather than by a shared key. A second registration of the same visit
hits the visit's own uniqueness guard; a second entry or exit hits the `409` from SMB-47; the
reminder, escalation and task-deadline jobs claim their rows by the same update that stamps
`reminder_sent_at` or moves the status, so a row cannot be picked twice. No producer-supplied
`event_id` column was added, because no producer has one to supply.

`notification_deliveries` is unique on `(notification_id, channel)` as well, so a notification
cannot grow a second copy of a channel.

## Fixed in this pass

`fanOut` took the recipient list from the calling service and checked only that each account was
active. It did not check that the recipient belongs to the society the event is about, so a
wrong list — a caller's bug, or an account moved to another society while an event sat in the
queue — would have delivered a society's notification to an outsider. The recipient query now
also requires `users.society_id = event.society_id`.

No caller was passing a cross-society recipient, so this changes no existing behaviour; it moves
the check from "every caller gets it right" to "the dispatcher enforces it". One line, covered
by "drops a recipient who belongs to another society, and one whose account is off".

**A turn-away at the gate now has its own event.** `rejectVisitAtGate` raised `VISITOR_DECIDED`
with `status: 'REJECTED_AT_GATE'`, which the flat read as "Visitor decided — Dev Courier for
A-101: rejected_at_gate." It now raises `VISITOR_ENTRY_REJECTED`, which reads "Visitor turned
away — Dev Courier was not let in for A-101." Migration `0037_notification_entry_rejected`
(one `ALTER TYPE … ADD VALUE`), covered by "tells the flat a visitor was turned away, in its own
words and not as a decision". The frontend's event union was two values out of date and is now
in step.

## Not built, and why

| §3 event | Why not |
| --- | --- |
| VISITOR_PRE_APPROVED | A pass is created by the resident who then hands the code to their own visitor, and the guard reads it at the gate when it is presented. Nobody has been named who needs telling at the moment of creation, and the subtask itself qualifies it "where required". |
| STAFF_VERIFICATION_REQUIRED | SMB-75 owns staff verification, and no rule says when verification becomes "required" rather than simply pending. Inventing the trigger here would put a business rule in the delivery layer, which §1 forbids. |
| SYSTEM_NOTIFICATION | A catch-all with no sender. Every system-level notice that exists has a specific type; adding a generic one now invites callers to use it instead of naming their event. |

## Open, pending the later sections

- **Delivery status** is recorded per channel but has no read path. Whether that should be an
  admin screen, an ops endpoint or nothing at all is a product decision; §2 only lists it.
- **Audit logging** of notification activity: the scope line pairs "security and audit logging",
  and the security half is built. Whether a delivery or a read deserves its own `audit_logs` row
  is not something to guess at — no business rule has been given.
- **Role-based** recipient validation: society and active-account are enforced; no rule has been
  stated that a given event type may only reach a given role, and the calling services already
  choose recipients by role.
- History is capped at the newest 50 with no paging.
