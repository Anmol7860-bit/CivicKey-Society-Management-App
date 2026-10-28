# SMB-75 — Staff movement and verification conformance

What the code does against the SMB-75 subtask. SMB-75 consumes the staff profile SMB-7 owns;
it creates no profiles, accounts or visitor records.

## Built

| Area | Where |
| --- | --- |
| Verify a staff member at the gate | `GET /staff/:id/verification` — name, type, photo, active, `currentlyInside`, `movementState`, `blockedReason`; the identity hash and home address never leave |
| Look one up by pass number | `GET /societies/:societyId/staff-pass/:passCode` |
| Record entry | `POST /staff/:id/entry` |
| Record exit | `POST /staff/:id/exit` |
| Record a refused entry with a reason | `POST /staff/:id/movement/entry-rejection` |
| Who is inside now | `GET /societies/:societyId/staff-inside` |
| Movement history, filtered and paged | `GET /societies/:societyId/staff-movements` — `staffId`, `staffType`, `gateId`, `dateFrom`, `dateTo`, `eventType`, `verificationStatus`, `limit`, `offset` |
| Guard screen | `frontend/src/features/gate/GatePage.tsx` — pass lookup, verification card, Record entry / Exit / Reject, inside list |
| Admin screen | `frontend/src/features/staff/StaffMovementPage.tsx` — history with filters and paging |

Storage reuses SMB-7's tables rather than adding `staff_movement_events`: a `staff_attendance` row
is the open visit (entry and exit on one row, which is what makes "at most one inside" a database
rule), and `staff_entry_rejections` keeps refusals, which are not attendance. The history endpoint
merges both into `ENTRY` / `EXIT` / `ENTRY_REJECTED` events with `VERIFIED` / `REJECTED` status, so
the API shape of the subtask is met without a second source of truth.

## Acceptance criteria

| AC | State | Proof |
| --- | --- | --- |
| AC1 staff lookup | Done | `gate.test.ts` "returns only what the gate needs…" |
| AC2 active staff can enter | Done | `gate.test.ts` "records an entry and an exit…" |
| AC3 inactive staff rejected | Done | `gate.test.ts` "refuses entry for an inactive staff member…" |
| AC4 society isolation | Done | `gate.test.ts` "keeps staff movement inside the society" |
| AC5 one ENTRY, server timestamp | Done | same as AC2 |
| AC6 no duplicate active entry | Done | partial unique index on the open row |
| AC7 exit | Done | same as AC2 |
| AC8 exit when not inside refused | Done | `gate.test.ts` "refuses an exit, and a second exit…" |
| AC9 rejection reason recorded | Done | `gate.test.ts` "records a refused entry with its reason…"; `OTHER` requires a note |
| AC10 idempotency | Done | `entry_key` / `exit_key` per staff member; "answers a retried entry or exit…" |
| AC11 concurrent entry | Done | "lets only one of two simultaneous entries through" — one 201, one 409 |
| AC12 server timestamp | Done | timestamps are set by the server, never sent by the client |
| AC13 history survives deactivation | Done | "reads back entries, exits and refusals…" |
| AC14 authorization | Done | permissions plus society scope; "refuses staff movement and its history to a resident" |
| AC15 event published to SMB-52 | Done | `STAFF_ENTERED` / `STAFF_EXITED` go to the notification outbox after the movement; delivery is the dispatcher's own later work |

Guard authorization is the full chain: authenticated, a staff permission, an active account and
live session, the same society, and the gate they are posted to (`assertGateAssigned`).

## Deliberately not built

| Item | Why |
| --- | --- |
| `staff_movement_events` table as written in the subtask | `staff_attendance` + `staff_entry_rejections` already hold it; a second source of truth was avoided |
| Correction / amendment flow (§29) | The subtask allows handling it administratively in the first release |
| Offline staff movement (§30) | Online-only by the subtask's own policy |
| Search by registered mobile at the gate | The pass number and the staff id both resolve; no second lookup added without a ticket |
