# SMB-52 — Real-time notifications

Covers §1–2 as given (objective and scope). The rest of the subtask has not been handed over
yet, so this is an audit of what already stands against the in-scope list, plus the one gap it
turned up. It will grow as the later sections arrive.

## §1 Objective — the boundary holds

The module "shall not independently approve visitors, record gate entry/exit, or perform staff
verification". It does not: `enqueueNotification` only writes an outbox row, and it is called
*with the caller's own transaction* so the event and the change it describes commit together.
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

## Fixed in this pass

`fanOut` took the recipient list from the calling service and checked only that each account was
active. It did not check that the recipient belongs to the society the event is about, so a
wrong list — a caller's bug, or an account moved to another society while an event sat in the
queue — would have delivered a society's notification to an outsider. The recipient query now
also requires `users.society_id = event.society_id`.

No caller was passing a cross-society recipient, so this changes no existing behaviour; it moves
the check from "every caller gets it right" to "the dispatcher enforces it". One line, covered
by "drops a recipient who belongs to another society, and one whose account is off".

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
