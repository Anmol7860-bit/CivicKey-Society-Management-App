# SMB-49 — Visitor registration at the gate conformance

What the code does against the SMB-49 subtask (sections 1–3 as received). Registration creates a
visit and starts the SMB-50 approval; it never admits anyone. Entry, exit, rejection and the
delivery handover stay separate calls.

## Built

| Area | Where |
| --- | --- |
| Register a visitor | `POST /societies/:societyId/visits` — `gate.routes.ts`, validated by `registerVisitAtGateSchema` |
| Guard's form | `frontend/src/features/gate/VisitorRegistrationPage.tsx` |
| Returning visitor by mobile | `GET /societies/:societyId/visitor-lookup?phone=` — fills the form, never reuses the visit |
| Flat and resident picker | `GET /societies/:societyId/flat-directory` — each flat with its current residents and their ids |
| Pass arrival | `entryCode` on the same call; the pass approves the visit outright (SMB-50) |
| Photo storage | `POST /files` — bytes on disk, EXIF stripped (`file/strip.ts`), served only to the signed-in society |
| Approval request | `notification_outbox` `VISITOR_WAITING_APPROVAL` to the resident who was asked for |
| Guard rejection with a reason | `POST /visits/:id/decision` with `DENIED` and a reason |
| Leave at gate | the same call with `LEAVE_AT_GATE` |
| Audit | `VISIT_REGISTERED`, and `VISIT_MANUAL_OFFLINE_ENTRY` for an outage entry |

## Mandatory information (section 3)

| Field | State | Where |
| --- | --- | --- |
| Visitor name | Required | `registerVisitSchema.visitorName`, 2–120 characters |
| Visitor mobile | Required | 10 digits, `^[6-9]\d{9}$`, also a check constraint on `visits` |
| Photograph taken at the gate | Required | `registerVisitAtGateSchema` refuses a form without `photoReference`; the reference must be a file this society stored |
| Purpose | Required | `purpose` enum, plus the free `note` |
| Destination block and flat | Required | `flatId`; the block comes with the flat, and the flat must be active and in this society |
| Intended resident | Required for a guest | `intendedResidentId`, and they must currently live in that flat |
| Expected date and time | Required | `expectedDate` + `expectedTime` → `visits.expected_at` |
| Registration timestamp | Generated | `visits.created_at` |
| Unique visit ID | Generated | `visits.id`, a uuid per visit — the mobile number is never the key, as the lookup shows |
| Registered-by guard | Derived | `visits.registered_by` from the authenticated context, never the body |

## Decisions worth knowing

- **The approval goes to the resident who was asked for**, when they hold FULL access to the flat;
  otherwise it falls to the flat's usual approver (tenant over owner), which is the shared-household
  and shared-tenant routing SMB-50 already had. The one-minute reminder follows the same person.
- **A pass holder is exempt from the photograph, the expected time and the named resident.** They
  were identified and approved when the resident issued the pass, and the pass carries its own
  window. Everybody the guard registers by hand is photographed and timed at the gate.
- **An offline registration is exempt too**, for the same practical reason: a queued form has no
  server to store a photograph on. The replay validates against `registerVisitSchema`, the same
  object without those refusals, and arrives flagged for review.
- **Duplicate protection** is the `visits_client_event_id_unique` index. The form carries one
  `clientEventId` per fill, so a second tap after a lost answer is refused with 409 `ALREADY_EXISTS`
  rather than registering a second visit. The same column already de-duplicated offline replays.

## Not built, and why

| Item | Why |
| --- | --- |
| Visit validity / expiry window | The sections that define it were not in the subtask as received. An unanswered visit already escalates to the guard after three minutes (`escalate_at`), which is the only expiry the code has. |
| Collection acknowledgment for a parcel left at the gate | `LEAVE_AT_GATE` records the resident's answer; nothing records the resident later collecting it. Needs a column, so it waits for the section that specifies it. |
| Visitor pass and QR | SMB-50 |
| Entry, exit, movement history | SMB-51 |
| Real-time notification delivery | SMB-52; registration only writes the outbox row |
| Offline registration | Out of scope for the initial release; what exists is the manual-entry path for an outage, flagged for review |

## Tests

- `backend/src/modules/gate/gate.test.ts`
  - "insists on the photograph, the expected time and, for a guest, who they asked for" — 422 for each
    missing field, 404 for a photo from another society, 400 for a resident who does not live there
  - "asks the resident the visitor came to see, and keeps the expected time they gave" — the outbox
    row names that resident, and `expected_at` is what the guard typed, not the registration time
  - "refuses the same form twice, so a retry cannot register two visits" — 409 `ALREADY_EXISTS`
- `frontend/src/features/gate/VisitorRegistrationPage.test.tsx`
  - "registers a visitor against a flat and says the resident was asked" — photo, date and time go with it
  - "will not send a guest until the gate says who they asked for, and sends that resident"
