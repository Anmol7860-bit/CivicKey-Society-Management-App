# SMB-49 — Visitor registration at the gate conformance

What the code does against the SMB-49 subtask (sections 1–8 as received). Registration creates a
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

## Visit id and duplicates (section 6)

`visits.id` is a v4 uuid the database generates, so it is unique and not guessable. The mobile
number has no unique index and never will: `visitor-lookup` finds the last visit by phone only to
fill the form in, and each registration is its own row with its own approval, expiry, status and
movement. `clientEventId` is a separate column with its own unique index — one id per filled-in
form or queued offline event — so a retry is answered with 409 `ALREADY_EXISTS` instead of a second
visit. A `CLOSED` visit cannot be entered again: entry only ever moves a row out of `APPROVED`.

## Times and expiry (section 7)

Each timestamp has its own column and none stands in for another: `expected_at` (what the guard
typed), `created_at` (registration), `decided_at` (the answer), `entered_at` / `exited_at` (the
gate's own, written by SMB-51's operations), and `cancelled_at`.

- **Default validity is 24 hours**, counted by the backend from registration into `expires_at`, and
  enforced at entry. The number is `society_settings.visit_validity_hours`, editable in Society →
  Settings, so the product owner moves it without a deployment.
- **A pre-approved arrival keeps the pass's own window.** When a visit is registered with an entry
  code, `expires_at` is the pass's `valid_on` + `valid_until`, not 24 hours from now, so an advance
  booking made last week does not arrive expired.
- **Expiry blocks a new entry and nothing else.** There is no job that closes visits: the check
  lives in `recordEntry`, so a visitor already inside stays inside, no exit timestamp is ever
  invented, and the guard still records the real exit. Signing out of the resident app touches
  nothing here.

## Submission, cancellation and gate rejection (section 8)

- **8.1** The guard's form shows every field before the Send button, and after submission there is
  no route that edits or cancels a visit as the guard — none was ever built, and none was added.
  The visit id comes back in the response and the approval request goes out in the same
  transaction. A wrong detail means a new registration; the first row stays, with its audit.
- **8.2** `POST /visits/:id/cancel`, behind `VISITOR_APPROVE` and limited to a resident the Admin
  set up to answer visitors for that flat. Allowed from `AWAITING_APPROVAL`, `AWAITING_MANUAL`,
  `APPROVED` and `LEAVE_AT_GATE`; refused once the visitor is inside, because cancelling then would
  have to invent an exit. The reason is optional; `cancelled_by` and `cancelled_at` are not, and a
  check constraint keeps the pair together. The row is kept, `VISIT_CANCELLED` is audited, the flat
  and the registering guard are notified, and entry afterwards is refused.
- **8.3** `POST /visits/:id/gate-rejection`, behind `VISIT_ENTRY_RECORD`, writing the distinct
  status `REJECTED_AT_GATE` with a mandatory reason from the enum — approval not received, details
  mismatch, verification failed, invalid or expired pass, security concern, or other with an
  explanation. It records the guard and the moment. It is not a resident's `DENIED`, it cannot
  approve anybody, it edits nothing that was registered, and it cannot touch a visitor already
  inside. A visit the resident approved may still be turned away at the gate, which is the SMB-51
  case the subtask points at.

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
| A correction or re-registration procedure (§8.1) | Beyond "register again", which works today. The approved business rule for amending a submitted visit has not been given, and inventing one would be the silent overwrite the subtask forbids |
| A status check constraint on cancellation and gate rejection | Postgres refuses a constraint naming an enum value added in the same migration, and Drizzle runs every pending migration in one transaction. The service enforces both halves; the DB enforces that `cancelled_at` and `cancelled_by` arrive together |
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
  - "gives every visit of the same person its own id, and never lets a closed one back in"
  - "expires a registration after the society's own window, and only for a new entry" — the hours
    setting is honoured, an expired visit is refused entry, and one already inside keeps its status
    and its null exit until the guard records it
  - "keeps a pre-approved visit on its pass window instead of the standard day"
  - "lets the resident call a visit off, and nobody else" — 403 for the guard, actor and moment
    recorded, no exit invented, entry refused afterwards, second cancel refused
  - "refuses to cancel a visitor who is already inside"
  - "records a gate rejection with its reason, apart from a resident's denial" — 422 for `OTHER`
    with no explanation, guard and timestamp recorded, entry refused, and an approved visit can
    still be turned away but never approved at the gate
- `frontend/src/features/gate/GatePage.test.tsx`
  - "turns an approved visitor away with a reason, and asks for one when it is Other"
- `frontend/src/features/gate/VisitorRegistrationPage.test.tsx`
  - "registers a visitor against a flat and says the resident was asked" — photo, date and time go with it
  - "will not send a guest until the gate says who they asked for, and sends that resident"
  - "offers only the society's visitor types, and makes the guard describe an Other" — including the
    number the guard is given when nobody can approve
