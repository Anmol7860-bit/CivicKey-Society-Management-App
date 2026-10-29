# SMB-47 — Gate entry & exit, and visitor movement history

Covers the subtask's §1–22 (SMB-63 Gate Entry, SMB-64 Gate Exit, SMB-65 Visitor Movement
History, SMB-66 Gate Entry & Exit Tests). Written against the code as it stands, not against
intent: every row below is either built and tested, or listed in "Not built and why".

## Schema: nothing new

The subtask asks to review the existing schema before adding a movement-event table. `visits`
already carries the whole movement record — `entered_at`/`entry_by`, `exited_at`/`exit_by`,
`rejection_reason` with `decided_at`/`decided_by`, plus `gate_id` and the constraint
`visits_exit_after_entry` — and at most one entry period per visit is exactly what the single
pair of columns enforces. A second table would be a duplicate record of the same movement, so
**no migration was added**. The movement *state* is derived (`movementStateOf`), never stored,
which is what keeps approval status and movement state separate (§8).

| Movement state | Derived from |
| --- | --- |
| `NOT_ENTERED` | no `entered_at` |
| `INSIDE` | `entered_at` set, `exited_at` null |
| `EXITED` | `exited_at` set |
| `ENTRY_REJECTED` | status `REJECTED_AT_GATE` |

ponytail: `visitorMovementHistory` scans at most 1000 visits before paging, so `total` counts
only that window. Filters narrow it. A movement-event table is the upgrade if a society ever
needs an exact count across years.

## Built in this subtask

| § | What | Where |
| --- | --- | --- |
| 6, 11.4 | A second entry on a visit already inside or closed answers 409 `ALREADY_EXISTS` carrying the current `movementState`, `enteredAt` and `exitedAt`, instead of a bare refusal | `gate.service.ts` `alreadyMoved`, `recordEntry` |
| 7, 11.4 | The same for a repeated exit, including the race lost to a concurrent guard | `recordExit` |
| 8 | `MovementState` and `movementStateOf`, derived from the recorded events | `gate.service.ts` |
| 9 | Visitors Inside flags a visit past its window as overdue — a prompt for the guard, never an automatic exit | `listInside`, `GatePage.tsx` |
| 10, 14 | `GET /visits/:id/movement-history` — one visit's entry, exit and refusal in order, with the actor behind each | `visitMovementHistory`, route |
| 10, 14, 16 | `GET /societies/:societyId/visitor-movements` — filter by visitor name/phone, flat, gate, guard, visit id, event type, movement state and date range; paginated | `visitorMovementHistory`, `VisitorMovementPage.tsx` |
| 16 | The office's Visitor movement screen, beside the existing Staff movement one | `frontend/src/features/gate/VisitorMovementPage.tsx` |

Everything else in §5–13 was already standing from SMB-46/SMB-49/SMB-50: gate assignment and
society scope on every movement, server timestamps, approval revalidated at entry, expiry that
blocks a new entry and nothing else, cancellation, refusal at the gate with a mandatory reason,
and Leave at Gate as a handover that writes no movement.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC1 authorized entry | Done | `recordEntry` requires status `APPROVED`; server `new Date()`; `gate.test.ts` "waits on the resident, then records entry and exit" |
| AC2 pending or denied | Done | same state check; "will not let in a visit the resident denied or left at the gate" |
| AC3 valid pre-approval | Done | `validatePass` + `registerVisit` with `entryCode`; the pass is closed on entry |
| AC4 expired or cancelled | Done | `expiresAt` check in `recordEntry`; cancellation refuses once entered |
| AC5 record exit | Done | `recordExit` |
| AC6 exit without entry | Done | `assertState(status === ENTERED)` |
| AC7 duplicate entry | Done | 409 with the current state; "never lets a closed one back in" |
| AC8 duplicate exit | Done | 409 with the current state |
| AC9 server timestamps | Done | no timestamp is read from the request body on either route |
| AC10 visitors inside | Done | `listInside` selects status `ENTERED` only |
| AC11 exited visitor | Done | same; asserted in the expiry test |
| AC12 expiry creates no exit | Done | expiry is checked only in `recordEntry`; no job touches movement |
| AC13 Leave at Gate | Done | `recordLeaveAtGate` writes a handover row and no `entered_at` |
| AC14 multiple visits | Done | every route takes the visit id; "gives every visit of the same person its own id" |
| AC15 society and gate scope | Done | `assertSameSociety` + `assertGate` on entry; cross-society read is 403 |
| AC16 entry rejection | Done | `rejectVisitAtGate`, reason mandatory, note required for `OTHER` |
| AC17 movement history | Partly | entry, exit and refusal are shown with timestamps and actors; correction events do not exist (AC18) |
| AC18 correction audit | Not built | see below |
| AC19 concurrent actions | Done | both writes are conditional `UPDATE … WHERE status = …`; the loser is handed the current state |
| AC20 network failure and retry | Partly | the sync queue is keyed per request id, so a replay cannot double-record; the queue itself is SMB-4's, see §17 below |
| AC21 deactivated guard | Done | `requirePermission` loads no permissions for an inactive user |
| AC22 history search and pagination | Done | `visitorMovementHistory`, `limit`/`offset`, "searches the society's movement history…" |
| AC23 responsive interface | Done | the same panel/table components as every other gate screen |
| AC24 no false success | Done | the UI renders the server's returned visit; a refusal throws |

## Not built, and why

| § | Ask | Why not |
| --- | --- | --- |
| 11.1, AC18 | Admin correction of a wrong entry or exit | The subtask makes it conditional — "may be provided … **if approved by the product owner**". No approved correction rule exists, so no correction path, no half-built audit trail. The guard's error route today is the office and the audit log, which already records every movement. |
| 17 | Online-only movement recording | `VISIT_ENTRY_RECORD` and `VISIT_EXIT` are queueable operations in SMB-4's offline sync, with tests that depend on them. §17 calls online-only a *recommendation*; retiring the queued movement is a product decision that would retire SMB-4 behaviour, so it was left alone. The queue is idempotent per request id, which is what AC20 actually needs. |
| 7.2 | Re-entry policy | A returning visitor is registered again, which is the subtask's own recommended default. No code was needed. |
| 15 | `visit_movement_events` table, gate ids on events | The visit row already holds one entry period, its actors and its gate. See "Schema: nothing new". |

## Tests

Backend `backend/src/modules/gate/gate.test.ts`:

- "waits on the resident, then records entry and exit" — AC1, AC5, AC9
- "gives every visit of the same person its own id, and never lets a closed one back in" — AC7, AC14
- "expires a registration after the society's own window, and only for a new entry" — AC4, AC8, AC11, AC12
- "will not let in a visit the resident denied or left at the gate" — AC2, AC13
- "reads one visit's movement back as entry, exit and the actor behind each" — AC10, AC17
- "keeps a refusal at the gate in the history without ever showing it as an entry" — AC16
- "searches the society's movement history, filters it and hands it back in pages" — AC15, AC22

Frontend `frontend/src/features/gate/VisitorMovementPage.test.tsx` — the office screen, its
filters, its paging and its empty state (AC22, AC23).
