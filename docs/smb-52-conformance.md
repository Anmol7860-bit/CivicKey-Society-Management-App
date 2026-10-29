# SMB-52 — Real-time notifications

Covers the subtask in full, §1–24. An audit of what already stands, plus the gaps it turned up
and what was built to close them. An audit of what already stands, plus the gaps it turned up. It will grow as the
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

## §8 Real-time delivery — the room is the server's to choose

Three rooms, all assigned from the verified handshake in `realtime.ts`:

| Room | Who is in it |
| --- | --- |
| `user:{userId}` | that person's every open tab and device; this is the notification channel |
| `society:{societyId}` | the society read from the **database**, not the token, because a token outlives a transfer |
| `session:{sessionId}` | one sign-in, so a logout drops that device and leaves the others connected |

> The frontend must never be allowed to subscribe to another user's private notification channel
> merely by changing an ID.

It cannot, because there is no ID to change. The handshake carries an access token and nothing
else; the user id comes from its verified subject, and the rooms are joined by the server on
connection. **There is no join handler at all** — a client that emits one is ignored rather than
checked, which is the version of this rule that cannot be got wrong later. An inactive account is
refused at the handshake.

The subtask's alternative name, `society:{societyId}:user:{userId}`, is not used. Membership of a
society is a property of the account, so folding it into the room name would mean rebuilding
every room when somebody transfers, and the society check already happens where it decides
something — `fanOut`, before a notification row exists (§4).

## §9 Web Push — the four conditions

| Condition | Where |
| --- | --- |
| the application is not currently open | **added here**: a `PUSH` delivery is skipped when `isConnected(userId)` finds a live socket for that person |
| the browser supports push | no support means no subscription is ever posted, and `PUSH` is `SKIPPED` at fan-out |
| the user has granted permission | a subscription exists only after the browser granted it |
| a valid push subscription exists | `push_subscriptions`, `is_active`; a permanent rejection from the push service deactivates that endpoint |

Push is optional, and nothing depends on it: the `IN_APP` record is written first, in the fan-out
transaction, before any channel is attempted. A person with no push, no email and no socket still
has every notification in the notification centre.

`isConnected` reads this process's own Socket.IO rooms, which is why it carries a `ponytail:`
comment. With more than one API instance, an instance that does not hold the connection would
still push; a shared adapter is the upgrade, and only worth it once there is a second instance.
There is no automated test for the skip, because the suite has no socket client and the one-line
guard did not justify adding one — the condition is a single `isConnected` call.

## §10 Lifecycle

The recommended states are derived from the delivery rows rather than stored, so a status can
never disagree with the rows it describes. `listNotifications` returns one as `deliveryStatus`:

| State | How it is derived |
| --- | --- |
| `CREATED` | the record exists and no outbound channel has reported success yet |
| `DELIVERED` | some channel other than `IN_APP` is `SENT` |
| `READ` | `read_at` is set; it wins over the others, because the person has it |
| `DELIVERY_FAILED` | nothing was sent and some channel is `DEAD` — five attempts over an hour and a half |
| retry | a channel sits at `PENDING` with `attempts > 0` and `next_attempt_at` in the future: 30s, 2m, 10m, 1h |

`IN_APP` is excluded on purpose: it is `SENT` the moment the record is written, so counting it
would make every notification read `DELIVERED` from birth and the state would say nothing.

> A failed push must not mean that the business event failed.

It cannot, and not by convention. The event is written to the outbox inside the transaction that
made the change (§6.1) and is then handed to a dispatcher **pass that runs later and separately**.
A channel failure writes to `notification_deliveries` and nothing else; there is no path from a
dead push back to the visit it was about.

## §11 Notification data

| Field asked for | Where it is |
| --- | --- |
| notification ID | `notifications.id` |
| event ID | `notifications.outbox_id` — the outbox row is the application event |
| recipient user ID | `notifications.user_id` |
| society ID | `notifications.society_id` |
| notification type | `notifications.event_type` (a Postgres enum, not a string) |
| title | rendered by `describe()`, not stored — see below |
| short message | the same, returned as `body` |
| related entity type / ID | `entity_type`, `entity_id` |
| created / read timestamp | `created_at`, `read_at` |
| delivery status | **added here**: `deliveryStatus` on each item in the read path (§10) |
| metadata where required | `payload` (jsonb), the values the message is built from |
| deep-link / navigation target | **not built** — see below |

**Title and message are rendered, not stored.** One switch in `describe()` turns an event and its
payload into the two lines, and every channel uses it: the socket event, the push, the email and
the notification centre read the same words. Wording is corrected in one place and old
notifications say the new thing, which is the behaviour wanted here; a stored string would freeze
whatever was written the day it was sent.

**The deep link is not built.** The subtask calls it optional, and the same notification belongs
on a different screen for each role — a guard opens a visit at the gate, a resident opens it in
their own visitor list. Picking one without a rule would send half the recipients to a screen
their role cannot open. Web Push points at `/notifications`, the one screen every role has.

> Avoid storing unnecessary sensitive visitor information inside notification text.

Checked, every payload in the codebase: visitor or staff name, flat label, purpose, rejection
reason, decision status, a due date, a bill amount, a task title, a receipt number. No phone
number, no identity document, no address, no token, and no other flat's balance. The rule is also
written on `OutboxEvent.payload` where a new caller will read it.

## §12 DDL — reconciled with the schema that exists

The proposal matches what is there, with the differences the project's own schema already
decided. No migration is written for this section: the two tables below are in production use and
the proposal is explicitly a logical design "to be reconciled".

| Proposed column | In `notifications` | Note |
| --- | --- | --- |
| `notification_id UUID PK` | `id uuid primary key default gen_random_uuid()` | |
| `event_id UUID NOT NULL` | `outbox_id uuid references notification_outbox on delete set null` | nullable so a purged outbox row does not take the notification with it |
| `recipient_user_id UUID` | `user_id uuid not null references users on delete cascade` | |
| `society_id UUID` | `society_id uuid not null references societies` | |
| `notification_type VARCHAR(100)` | `event_type notification_event` | an enum: a typo is a failed insert rather than a row nobody can render |
| `title VARCHAR(200)`, `message TEXT` | — | rendered from `event_type` + `payload`; see §11 |
| `related_entity_type VARCHAR(50)` | `entity_type varchar(40)` | |
| `related_entity_id UUID` | `entity_id uuid` | |
| `delivery_status VARCHAR(30)` | — | one row per channel in `notification_deliveries` (`status`, `attempts`, `last_error`, `next_attempt_at`, `sent_at`); the single value is derived (§10) |
| `created_at`, `read_at` | the same | |
| `delivered_at` | `notification_deliveries.sent_at` | per channel, because "delivered" is a different fact for a socket and for an email |

| Proposed index | Built |
| --- | --- |
| `(recipient_user_id, created_at DESC)` | `notifications_user_created_idx` on `(user_id, created_at)` — Postgres reads a btree backwards, so it serves the `desc` listing |
| `(society_id, created_at DESC)` | **not built**: nothing reads notifications by society. Every read is one person's own, and an index that no query uses is paid for on every insert |
| `(event_id)` | covered: `outbox_id` leads the unique index below |
| `unique (event_id, recipient_user_id, notification_type)` | `notifications_outbox_user_unique` on `(outbox_id, user_id)` — stronger, since the type is a column of the outbox row (§7) |

Also built and not in the proposal: `notifications_user_unread_idx`, a partial index on
`(user_id) where read_at is null`, which is what the unread badge counts.


## §13 Push subscription data

| Proposed column | In `push_subscriptions` |
| --- | --- |
| `subscription_id UUID PK` | `id uuid primary key default gen_random_uuid()` |
| `user_id UUID NOT NULL` | `user_id uuid not null references users on delete cascade` |
| `endpoint TEXT NOT NULL` | `endpoint text not null`, with `push_subscriptions_endpoint_unique` |
| `subscription_data JSONB` | `p256dh` and `auth` as columns | 
| `active BOOLEAN DEFAULT TRUE` | `is_active boolean not null default true` |
| `created_at` / `updated_at` | the same |

Two deliberate differences. The keys are **columns, not a jsonb blob**: there are exactly two of
them, the push library needs both, and a column cannot be a subscription that parses but has no
`auth`. And the **endpoint is unique**, not the pair: the endpoint is what the push service
recognises, so the same browser arriving again is an update — moved to the current user and
reactivated — rather than a second row. That is what happens when two people share a device.

> A user may have multiple active subscriptions because they may use multiple devices/browsers.

They may: nothing restricts rows per user, and `fanOut` queues a push when *any* active
subscription exists while `attempt` sends to every one of them. A subscription the push service
permanently rejects is deactivated on its own, leaving the person's other devices alone. Covered
by "keeps one subscription per device, and only its owner may remove it".

## §14 API design — now the shapes the subtask names

The routes were renamed in this pass to the ones written here; the frontend moved with them.

| Subtask | Built |
| --- | --- |
| `GET /api/v1/notifications?page=&limit=&unreadOnly=` | the same — **paging and `unreadOnly` added here**; `page` defaults to 1, `limit` to 20 (max 100), and the response carries `items`, `unread`, `page`, `limit` |
| `PATCH /api/v1/notifications/:notificationId/read` | the same — was `POST .../read` |
| `PATCH /api/v1/notifications/read-all` | the same — was `POST /notifications/read` |
| `POST /api/v1/notifications/push-subscription` | the same — was `POST /notifications/push` |
| `DELETE /api/v1/notifications/push-subscription/:subscriptionId` | the same — was `DELETE /notifications/push?endpoint=`. The id-less form is kept beside it, because signing out wants every device at once |
| `NotificationService.publish(event)` | `enqueueNotification(executor, event)` — an internal function taking the caller's transaction. **There is no public route that creates a notification**, which is the stronger version of the subtask's preference |

`GET /notifications/push-key` is not in the subtask and is kept: the browser cannot subscribe
without the VAPID public key, and a public key is public.

## §15 Backend validation

| Check | Where |
| --- | --- |
| authenticated event source | there is no route that publishes an event; the only caller is server code inside a transaction |
| valid event ID | the outbox row id is generated by the database |
| valid event type | a Postgres enum plus a TypeScript union: an unknown type cannot be inserted or compiled |
| valid society | `society_id` is a foreign key, and `fanOut` matches recipients against it |
| recipient exists / belongs to the society / is active | one query in `fanOut`: `users.id in (…) and is_active and society_id = event.society_id` |
| recipient is authorized for the event | resolved by the raising service from the flat or role relationship (§4); the dispatcher does not re-derive the business rule |
| related entity exists | the entity is written in the same transaction as the event (§6.1), so it exists by construction |
| duplicate event check | the unique index of §7 |
| notification template exists | `describe()` is exhaustive over the enum — a new event type that nobody wrote words for fails the build, not the delivery |

> Invalid recipient: do not create notification, log security/validation failure.

**Added here.** The recipients `fanOut` refuses were dropped silently; it now logs a warning
naming the outbox row, the event type, the society and the refused ids. Dropping them was already
right — writing it down is what makes a wrong recipient list findable.

## §16–17 UI

| Asked for | Where |
| --- | --- |
| bell, unread count, read/unread state | `AppShell`: a bell for every role that has a notifications screen, with the unread count as a badge (`9+` past nine) |
| recent notifications | `NotificationsPage`, newest first, unread ones tinted and announced to a screen reader |
| title, short message, time | each row, from the server's own `title` and `body` |
| related action | **not built** — the same deep-link decision as §11 |
| loading | `Skeleton`, and **only when there is nothing on screen yet** (changed here) |
| empty | `EmptyState`, separately for "nothing waiting on you" and "nothing sent yet" |
| real-time arrival | the socket event dispatches `civickey:notification` on `window`; every screen listening reloads, with no refresh |
| socket disconnected | **added here**: `useLiveStatus` tracks `connect` / `disconnect` / `connect_error`, and the page shows "Real-time updates unavailable. Notifications will refresh automatically." while it is down. It stays silent until the first attempt settles, so nothing is claimed either way while connecting |
| push permission denied | one line explaining the browser is blocking it. The offer to turn push on only appears when the state is `OFF`, so a refusal is never asked again |
| network failure | **changed here**: a failed refresh keeps what was already loaded. `useResource` now keeps its data beside the error, and the page only shows the error screen when it has nothing to show |

## §18–19 Diagrams

The sequence runs exactly as drawn — business module → `enqueueNotification` → validate and
resolve in `fanOut` → row in Postgres → `emitToUser` on the authorized room → the client → mark
read → `read_at`. One addition: the arrow from the business module is **inside the transaction**
(§6.1), and the arrow to Socket.IO is a later dispatcher pass, which is what keeps a dead socket
from touching the business change.

The state diagram is what §10 now returns, including both paths the drawing allows:
`DELIVERY_FAILED → DELIVERED` (a retry that works), and `CREATED → READ` (read in the
notification centre before any channel reported).

## §20 Validation and error handling

| Scenario | Result | Proven by |
| --- | --- | --- |
| Valid event | notification created | "fans one event out to an in-app record and a row per channel" |
| Duplicate event | existing notification reused | "does not tell the same person twice when a row is fanned out again" |
| Unknown event type | rejected | the enum: it cannot be inserted, and it cannot be compiled |
| Unauthorized recipient | not created, and logged | "drops a recipient who belongs to another society, and one whose account is off" |
| Inactive user | not delivered | the same test |
| Socket disconnected | notification persisted | the record is written before any channel is attempted |
| Push unavailable / permission denied | in-app notification remains | "sends a push only to someone with a live subscription" |
| Already read | no second state change | `{ marked: 0 }`, asserted in the read test |
| Invalid notification ID | 404 | **added here** — including an id that is not a uuid, which used to reach the database |
| Another user's notification | 404 | **changed here** — it used to answer `200 { marked: 0 }`, which told the caller the id was real |
| Business succeeds, push fails | business unaffected | §10, and the delivery rows carry the failure |

## §21 Security

Authentication on every notification route; recipients are never taken from a request; reads are
scoped to `req.ctx.userId` with no parameter that could widen them; society isolation is enforced
in `fanOut`; payloads carry no sensitive visitor data (§11); push subscription ownership is part
of the update, so another person's id is a 404 rather than a 403 that confirms it exists.

Audit: the actions that produce notifications write their own `audit_logs` rows, in the same
transaction (§6.1). A refused recipient is logged (§15). The notification records themselves
carry the event, the recipient, the society and a timestamp, and the delivery rows keep
`attempts` and `last_error`, which is the metadata AC10 asks for.

## §22 Dependencies

SMB-1/2/3 provide the auth, society and permission layers every route and the socket handshake
use. SMB-46, SMB-50, SMB-51 and SMB-75 are the event sources — visitor registration, approval,
gate entry/exit and staff movement all call `enqueueNotification` from inside their own
transactions. Nothing here reaches back into them. Related subtasks SMB-67 (Socket.IO), SMB-68,
SMB-69 (visitor and staff notifications) and SMB-70 (Web Push) are the parts described above;
SMB-71 is the test index below.

## §23 Acceptance criteria

| AC | Status | Where |
| --- | --- | --- |
| AC1 notification creation | Met | every event source enqueues on success; `fanOut` writes one record per authorized recipient |
| AC2 recipient security | Met | resolved server-side, re-checked for society and active account |
| AC3 real-time delivery | Met | `SOCKET` channel to `user:{id}`; the client reloads on arrival with no refresh |
| AC4 offline client | Met | the in-app record is written first and read later; the socket is one channel, never the record |
| AC5 duplicate prevention | Met | `unique (outbox_id, user_id)` |
| AC6 read state | Met | `read_at`, per person, idempotent |
| AC7 unauthorized access | Met | another person's notification is a 404 |
| AC8 push failure | Met | the in-app record is untouched by a channel |
| AC9 business independence | Met | the event commits with the change; delivery happens in a later pass and cannot roll it back |
| AC10 auditability | Met | audit rows for the actions, `attempts`/`last_error` per channel, and a logged line for a refused recipient |

## §24 Test index

| # | Test | Covered by |
| --- | --- | --- |
| 1 | notification for a valid event | "fans one event out to an in-app record and a row per channel" |
| 2 | the right resident is told | "writes the event in the same transaction as the visit it describes" |
| 3 | an unrelated resident is not | "never shows one person another person's notifications"; `flatAudience` selects that flat only |
| 4 | the guard is told | "tells the gate, not a resident, when the flat has nobody who can answer" |
| 5 | staff notification | gate tests for staff entry and exit raise `STAFF_ENTERED` / `STAFF_EXITED` to the flats served |
| 6 | Socket.IO delivery | the `SOCKET` channel is attempted and marked in "fans one event out…"; **no browser-level test** — the suite has no socket client |
| 7 | persistence | the same test: the record and its delivery rows outlive the pass |
| 8 | disconnected user reads it later | "shows a person their own, and marks them read" reads what was written while nobody was connected |
| 9 | unread count | the same test |
| 10 | mark as read | the same test |
| 11 | mark all read | the same test |
| 12 | duplicate event | "does not tell the same person twice when a row is fanned out again" |
| 13 | unauthorized access | "never shows one person another person's notifications" — now a 404 |
| 14 | invalid notification id | the same test, for an unknown uuid and for a string that is not one |
| 15 | inactive user | "drops a recipient who belongs to another society, and one whose account is off" |
| 16 | push subscription creation | "stores a push subscription once per browser…" |
| 17 | push subscription removal | the same test, and by id in "keeps one subscription per device…" |
| 18 | multiple devices | "keeps one subscription per device, and only its owner may remove it" |
| 19 | push permission denied | the page shows the blocked line and never re-asks; `pushState` returns `DENIED` |
| 20 | push delivery failure | "backs a failed channel off along the fixed ladder, then gives up" |
| 21 | real-time reconnect | "says so when live updates are not arriving, instead of implying they are", plus the reload on arrival |
| 22 | society isolation | "drops a recipient who belongs to another society…" |
| 23 | API authentication | "needs a signed-in person" |
| 24 | sensitive data | §11: audited across every payload in the codebase |
| 25 | notification failure does not reverse the business event | the delivery rows carry the failure; the visit tests pass unchanged with a dead channel |
| 26 | history pagination | "hands back one page at a time, and the unread ones on their own" |


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
