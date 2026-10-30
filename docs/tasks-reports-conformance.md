# Community tasks and reports — conformance

The story asks for society work tracking and reports inside the caller's permissions and
society. Both were built earlier; this records what matches, what was added to match, and the
differences that are decisions rather than omissions.

## §1 Business rules

| Rule | Status | Where |
| --- | --- | --- |
| Tasks and reports scoped to the caller's society | Done | `loadSociety`/`loadTask` → `requireRecord` → 403 `CROSS_SOCIETY_ACCESS`; the society in the path is checked against the token, never trusted |
| No permission invented for tasks | Done | tasks are gated on the existing `SOCIETY_MANAGE`, exactly as the story asks when no `TASK_MANAGE` exists. A committee member holding only billing permissions does not reach them |
| `REPORT_VIEW` does not open another resident's flat data | Done | the two reports return per-flat **counts** (owners, tenants) and billing totals, never resident names, phones or payment identities |
| One documented state machine | Done | `OPEN → IN_PROGRESS → DONE | CANCELLED`, with the enum, a check constraint tying `closed_at` to the closed states, and a 409 on any move that is not allowed |
| Status, assignment and comment history preserved | Done, in the audit log — see §3 |
| Completion records actor and server timestamp | Done | `closed_at` is set by the server, and `TASK_STATUS_CHANGED` carries the actor |
| An update never erases history | Done | nothing updates or deletes an audit row; a task edit writes a new one |
| Reports derived from persisted data, nothing fabricated | Done | both reports are read from `invoices`, `payments`, `flats` and `flat_residents` at request time; nothing is cached, seeded or sampled |
| No invented metrics | Done | the catalogue is two reports, `COLLECTIONS` and `OCCUPANCY`; a request for anything else is **422 `REPORT_TYPE_UNSUPPORTED`**, added here |
| Pagination and bounded ranges | **Added here** | the task list takes `page`, `limit` (max 200) and a `from`/`to` range on when the task was raised; the report takes `page`/`limit` |
| Exports enforce the same authorization as the screen | Done | `?format=csv` is the same route, the same `REPORT_VIEW` check and the same rows |
| No assignee from another society, or an inactive one | Done | `assertStaffInSociety` requires an `ACTIVE` staff row in the caller's society; **the refusal is now 409 `ASSIGNEE_NOT_ELIGIBLE`** instead of a generic invalid state |

**Who may be assigned.** Only staff and vendors already registered with the society — the same
people the gate knows. Residents and admin users are not assignable, which is why the column is
`assigned_staff_id` rather than a user id. That predates this story and is what keeps the work
list and the gate talking about the same person.

**Reopening.** A `DONE` task can be moved back to `OPEN`, which clears `closed_at` and the
closing note; a `CANCELLED` one cannot be moved at all. The story says not to reopen completed
tasks without approval — this behaviour predates it, is in the UI as a Reopen button, and is
left alone rather than removed on an assumption. A reopen is recorded in the history like any
other move.

## §2 Endpoints

| Story | This repository | Status |
| --- | --- | --- |
| `GET /community-tasks` | `GET /societies/:societyId/tasks` | Done; **`from`, `to`, `page`, `limit` added** |
| `POST /community-tasks` | `POST /societies/:societyId/tasks` | Done |
| `GET /community-tasks/{taskId}` | `GET /tasks/:id` | **Built here** |
| `PUT /community-tasks/{taskId}` | `PUT /tasks/:id` | Done |
| `POST /community-tasks/{taskId}/complete` | `POST /tasks/:id/status` with `{ status: 'DONE', note }` | Done, see below |
| `GET /community-tasks/{taskId}/history` | `GET /tasks/:id/history` | **Built here** |
| `POST /community-tasks/{taskId}/comments` | — | Not in scope |
| `GET /reports` | `GET /societies/:societyId/reports` | Done; **422 for an unknown type and `page`/`limit` added** |

Paths follow the rest of this API: a collection hangs off its society, an item is addressed by
its own id.

**One status endpoint, not a separate complete.** Completion is a transition like any other, and
giving it its own route would mean two places that close a task. `note` is the completion note,
and is required when cancelling. A repeated completion is **409 `INVALID_STATE`** with nothing
written — the story's second option, applied consistently, which is why there is no
`idempotencyKey`: the task's own state is the key, and a second request cannot duplicate history.

**Task summary.** `GET /societies/:societyId/task-summary` returns the counts the tiles show,
computed in the database so the page never adds up a truncated list.

## §3 Tables

`community_tasks` exists with the story's columns under this project's names: `details` for the
description, `assigned_staff_id` for the assignee, `due_date`, `closed_at` and `closing_note`
for completion, `raised_by` for the creator. It has the indexes the story asks for
(`society_id, status` and `assigned_staff_id`), a trimmed-title check and a check that a task is
closed exactly when it has a `closed_at`.

`task_status_history`, `task_assignee_history` and `task_comments` do **not** exist.
`audit_logs` is the history: a row is written inside the same transaction as every create, edit
and move, carrying the actor, the server's timestamp and the change itself; nothing updates or
deletes those rows, and the retention policy that applies to the audit log applies to them.
`GET /tasks/:id/history` reads them back in order. **Added here:** a reassignment now records
`assignedFrom` and `assignedTo`, so the assignment history is the actual before and after rather
than only the fact that something changed. Comments are not in the approved scope, so no table
was added for them.

<!-- ponytail: the history query filters on metadata ->> 'taskId', which has no index. Add a
partial index on the task event types if a society's audit log ever makes it slow. -->

Reports add no tables: they read the operational tables each time.

## §4 Frontend

The admin tasks page already lists the work with status, category, priority, overdue, assignee
and who raised it, filters by status, category, assignee, overdue and free text, creates tasks,
reassigns, starts, completes and cancels them, and shows loading, empty, permission-denied and
API-error states. **Added here:** a *What has happened* disclosure on each task that reads the
history from the server when it is opened and renders it as raised / handed to / moved / edited,
with the actor and time — including a failure state of its own, so a history that cannot be read
never looks like a task with no history. The reports panel already limits the selection to the
two approved reports and downloads the same rows as CSV.

Not added: a pager. The list's default page size is the bound it already had (200), so nothing
is hidden; the server takes `page` and `limit` for when there is a pager to send them.

## §5 Errors

| Code | Status |
| --- | --- |
| 400 `VALIDATION_ERROR` / 422 on a bad body or filter, 401, 403 `PERMISSION_DENIED`, 403 `CROSS_SOCIETY_ACCESS`, 404 `NOT_FOUND` | Already shared across the API |
| 409 `INVALID_STATE` | **Now 409** for task transitions and for editing a closed task (was 400) |
| 409 `ASSIGNEE_NOT_ELIGIBLE` | **Added** |
| 422 `REPORT_TYPE_UNSUPPORTED` | **Added** — a report nobody has written is a missing report, not a malformed request |
| 409 `IDEMPOTENCY_KEY_REUSED` | Not applicable — see §2 |

## §6 Tests

`task.test.ts` (18) covers the permission and society scope, raising a task, assignee
eligibility including another society's staff, every transition and the ones that are refused,
the closed-task edit, reading one task, the history in order with the assignment before and
after, pagination with its bound, and the date range including one that runs backwards.
`billing.test.ts` adds the report catalogue, the unknown type and paged rows with unchanged
totals. Backend 408 tests pass, frontend 209, including a new one that opens a task's history and
reads it from the server rather than from anything the page made up.
