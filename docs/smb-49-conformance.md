# SMB-49 — Visitor registration at the gate conformance

What the code does against the SMB-49 subtask (sections 1–5 as received). Registration creates a
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

## Visitor purposes (section 4)

All nine are in the `visit_purpose` enum, in the order the guard's form shows them:
`GUEST`, `FOOD_DELIVERY`, `DELIVERY` (parcel or courier, kept under its original name so no visit
history had to be rewritten), `CAB`, `DOMESTIC_HELP`, `MAINTENANCE`, `SERVICE`, `BUSINESS`, `OTHER`.

- **Configurable without a deployment.** `society_settings.visitor_purposes` holds the ones a
  society offers; empty means all nine. The Admin ticks them in Society → Settings, the gate reads
  them from `GET /societies/:id/visit-purposes`, and registration refuses a purpose the society
  does not use. A purpose a society invents for itself would still need the enum extended — that is
  the one part of "no code change" this does not cover, and it is called out rather than guessed at.
- **`OTHER` demands a description.** The note becomes required, in the schema and in the form.
- **Leave at gate** is `society_settings.leave_at_gate_allowed`, on by default, and only ever for
  `DELIVERY` or `FOOD_DELIVERY`. It was already not an entry approval: entry on a `LEAVE_AT_GATE`
  visit is refused, which `gate.test.ts` has covered since before this subtask.

## Destination and resident (section 5)

The backend re-derives everything from `flatId` and never trusts the rest: the block and society
come from the flat's own joins, so a mismatched pair cannot be sent. It checks the block is active,
the flat is active, the flat is in the society in the URL, the guard is signed in to that society,
and the named resident currently lives in that flat.

| Rule | How |
| --- | --- |
| 5.1 shared household | Every eligible resident of the flat is asked at once when nobody was named. One answer settles it; the second attempt gets 400, so no answer silently overwrites another, and `decided_by` records who it was |
| 5.2 shared tenants | Naming a tenant sends the request to that tenant alone. Nobody gains authority by sharing the flat: only the assignment's own flag grants it |
| 5.3 eligibility | `flat_residents.visitor_approval_eligible`, per assignment, set by the Admin in the resident directory and audited as `RESIDENT_UPDATED`. Owner or tenant, full or view-only, no longer decides it: registration defaults the flag from the access level and the Admin changes it from there. Existing rows were backfilled to what the gate did before (`access_level = 'FULL'`) |
| 5.4 nobody to ask | The visit is recorded `AWAITING_MANUAL` with no `decided_by`, and the registration answer carries `contact` — the intended resident's registered name and number — which the guard's screen shows with the warning that a call changes nothing until somebody answers in the app. The three-minute escalation to the guard is unchanged and stays SMB-50's |

A tenancy that lowers an owner to view-only now also stops the gate asking them, and gives it back
when the tenancy closes — the behaviour `syncOwnerAccess` already described in words.

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
| A society inventing its own purpose | The nine are an enum. A tenth needs a migration, which is a schema change the subtask did not ask for in so many words |
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
  - "offers the society's own visitor types and refuses one it does not use" — the nine in order,
    narrowed from settings, 400 for one outside the list, 422 for `OTHER` with no description
  - "asks every household approver at once when nobody was named" — both recipients, one answer
    enough, the second refused
  - "leaves a resident the Admin did not set up for visitors out of it" — not notified, cannot
    decide, and naming them routes the request to the flat's approver instead
  - "hands the guard a number to ring when the flat has nobody who may approve" — `AWAITING_MANUAL`,
    no `decided_by`, `contact` present
  - "leaves a parcel at the gate only for a delivery, and only while the society allows it"
- `frontend/src/features/gate/VisitorRegistrationPage.test.tsx`
  - "registers a visitor against a flat and says the resident was asked" — photo, date and time go with it
  - "will not send a guest until the gate says who they asked for, and sends that resident"
  - "offers only the society's visitor types, and makes the guard describe an Other" — including the
    number the guard is given when nobody can approve
