# Story 2 — Role-based access control conformance

Living record of what the code does, against the Story 2 BRD and the decisions taken
since. Nothing here is implemented from the document alone: where the document and the
built code differ, the difference is listed below and left for Jira to settle.

## Current direction

| Item | Direction | State |
| --- | --- | --- |
| Application roles | ADMIN, RESIDENT, GUARD only; owner and tenant are relationship types on the flat assignment | Done |
| One role per user | `user_roles` has the user id as its primary key | Done |
| Where permissions come from | GUARD and RESIDENT from `role_permissions`; every Admin permission is a per-user grant in `user_permissions`. ADMIN has **no** `role_permissions` rows at all | Done |
| Committee member | The ADMIN role plus only committee grants. Because ADMIN carries no role grants, there is nothing to union in, so the document's "never union General Admin grants" holds by construction | Done |
| Committee keeps resident functions | A verified, date-active `flat_residents` row adds the RESIDENT grants, whatever the role says. A staff Admin or Guard with no assignment gains nothing | Done |
| Freshness | Role, society and permissions are re-read from the database on every request; the token is never trusted for them, so a revoked grant stops working on the next call | Done |
| Order of checks | authenticate → permission → society scope → flat scope → state | Done |
| Denials | 403 from middleware, before the controller or any mutation, and recorded as `AUTHORIZATION_DENIED` with the code, method and path | Done |
| Frontend | One permission table drives navigation, stats and shortcuts; a page the user lacks permission for shows Access Denied. Hiding a control is for usability only | Done |

### Where it lives

- `backend/src/modules/access/permissions.ts` — the catalogue lists, `loadPermissions`, `isResident`, `getEffectivePermissions`, committee grant/revoke
- `backend/src/middleware/requirePermission.ts` — reads role, society and permissions from the database and sets `req.ctx`
- `backend/src/modules/access/scope.ts` — `assertSameSociety`, `requireRecord`, `assertState`, `assertFlatAccess`, `deny`
- `backend/src/middleware/requireFlatAccess.ts` — the `:flatId` wrapper; operations taking the flat from the body call `assertFlatAccess` themselves
- `backend/src/db/migrations/0006_roles_and_permission_tables.sql` — roles, permission master data and the GUARD/RESIDENT role grants
- `backend/src/modules/resident/resident.service.ts` — `syncOwnerAccess`: the tenant/owner access handover
- `frontend/src/features/shell/areas.ts` — `AREAS` and `allowed()`; `frontend/src/features/shell/AreaRoute.tsx` — Access Denied

### Tests covering it

| Behaviour | Test |
| --- | --- |
| The catalogue in code matches the permissions table | `backend/src/modules/access/permissions.test.ts` |
| Guards and Residents get role grants; Admins get none | `permissions.test.ts` |
| An Admin gets only the Admin permissions assigned to them | `permissions.test.ts` |
| Admin permissions stored for a non-Admin are ignored | `permissions.test.ts` |
| 403 PERMISSION_DENIED without saying which permission was missing | `permissions.test.ts` |
| The database role wins over a still-valid token's role | `permissions.test.ts` |
| A revoked permission stops working, and works again once re-granted | `permissions.test.ts` |
| Committee grants add to the resident ones, and removal restores the RESIDENT role and keeps the flat | `permissions.test.ts` |
| Committee membership does not bypass flat ownership | `backend/src/modules/access/scope.test.ts` |
| Own flat read and write; another flat 403 NOT_YOUR_FLAT; last valid day still active | `scope.test.ts` |
| A VIEW_ONLY resident may read but not write | `scope.test.ts` |
| A flat in another society is refused even with a scope permission | `scope.test.ts` |
| Denials are audited with the reason code | `scope.test.ts` |
| The owner goes view-only for the tenancy and back when it ends | `backend/src/modules/resident/resident.test.ts` |
| The tenant, not the owner, is asked while a tenant is in the flat | `backend/src/modules/gate/gate.test.ts` |
| `GET /auth/permissions` answers from the database, and 403s a deactivated or role-less user | `backend/src/modules/auth/permissionsEndpoint.test.ts` |
| Navigation and pages follow the permissions, not the role | `frontend/src/features/shell/AreaRoute.test.tsx` |

## Scenario catalogue — where each case is met

| Case | State | Note |
| --- | --- | --- |
| RBAC-01 General Admin action | Done | Permission checked per route; sensitive changes audited |
| RBAC-02 Committee-limited Admin action | Done | Committee grants only, plus own-flat resident functions from the flat assignment |
| RBAC-03 Resident own flat | Done | VERIFIED and date-active row; owner/tenant access level enforced on writes |
| RBAC-04 Resident another flat | Done | 403 NOT_YOUR_FLAT, 404 for an unknown or malformed id |
| RBAC-05 Tenant active, owner writes | Done | Owner lowered to VIEW_ONLY in the same transaction, restored on move-out without touching the account |
| RBAC-06 Guard on resident or finance API | Done | GUARD role grants cover none of them |
| RBAC-07 Direct API call | Done | 401/403 from middleware before the handler |
| RBAC-08 Cross-society identifier | Differs | Returns 403 CROSS_SOCIETY_ACCESS, not 404; the denial is audited. See gaps |
| RBAC-09 Committee grant/revoke | Partly | The service exists, is audited and is tested, but has no HTTP route and no screen. See gaps |
| RBAC-10 Approval versus gate decision | Done | `VISITOR_APPROVE` and `VISIT_DECIDE` are separate codes; the guard path only opens once a visit has escalated |

## Catalogue differences — deliberate

The permissions table holds 21 codes; the document lists 29.

| Document | Code today | Why |
| --- | --- | --- |
| `VISIT_GATE_DECIDE` | `VISIT_DECIDE` | Renamed; still separate from `VISITOR_APPROVE` |
| `VISIT_ENTRY` | `VISIT_ENTRY_RECORD` | Renamed |
| `INVOICE_ONE_TIME_CREATE` | `INVOICE_GENERATE` | One-time charges are part of generating invoices |
| `STAFF_VALIDATE`, `STAFF_MOVEMENT` | `PASS_VALIDATE`, `VISIT_ENTRY_RECORD`, `VISIT_EXIT` | The gate uses one set of codes for people at the gate, staff or visitor |
| `STAFF_MANAGE_OWN` | `VISIT_VIEW_OWN` | Own-flat daily help sits with the other own-flat screens |
| `TASK_MANAGE` | `SOCIETY_MANAGE` | Recorded in `docs/tasks-reports-conformance.md` |
| `VISIT_HISTORY_VIEW` | The gate bundle for the gate log; `AUDIT_VIEW`/`STAFF_MANAGE` for the admin movement screens | No separate history code |
| — | `GUARD_MANAGE` | Managing guards is separate from registering staff |
| `roles.code VARCHAR CHECK (...)` | `roles.name`, a `user_role` enum | Same three values, enforced by the enum |

## Gaps against the document — not implemented, awaiting Jira

| Document | Code today | Note |
| --- | --- | --- |
| `admin_access_profiles` with GENERAL_ADMIN / COMMITTEE_LIMITED | No such table; the distinction is implicit in which permissions were granted | It fails closed correctly, but the profile is not a stored fact, so `/auth/permissions` cannot report it and `loadPermissions` accepts any `ADMIN_PERMISSIONS` grant — the four-code committee allowlist is enforced only inside `setCommitteeMembership` |
| A General Admin grants and revokes committee permissions | `setCommitteeMembership` / `removeCommitteeMembership` exist, audited and tested, but have no route and no screen | Reachable only from the seed script and tests; RBAC-09 cannot be performed in the running product |
| `user_permissions.id` plus a partial unique index, so a regrant appends a row | Primary key `(user_id, permission_id)`; a regrant clears `revoked_at` on the same row | Per-grant lineage survives in `audit_logs`, not in the table |
| `/auth/permissions` returns `user`, `role`, `accessProfile`, `flatAccess[]` | Returns `userId`, `role`, `permissions` | Per-flat relationship and access level come from `GET /me/flats`. The frontend reads permissions from the login and refresh payloads and never calls this endpoint |
| RBAC-08 returns 404 NOT_FOUND for another society's identifier | 403 CROSS_SOCIETY_ACCESS | The denial is audited either way; `requireRecord` already returns 404 when the id exists nowhere, so only "exists, other society" is distinguishable |
| `NOTIFICATION_READ` | `/notifications` is `requireAuth` only, scoped to the caller's own user id | The code does not exist in the catalogue |
| `VISITOR_BLOCK_MANAGE` and society blocked-visitor records | Not built | Belongs to its own story |
| `requireSocietyScope()` as middleware | Each module has a `loadSociety` helper that goes through `requireRecord` → `assertSameSociety` | Same outcome; a new route has to remember to call it |

## Improvements suggested — no ticket yet

1. The committee flow has no door: a route pair and a screen on the admin society page would make RBAC-09 demonstrable.
2. Move the committee allowlist into `loadPermissions`, or add the profile table, so an off-allowlist grant to a committee account cannot take effect.
3. Decide 403 against 404 for cross-society identifiers; 34 call sites and `scope.test.ts` assert the current code.
4. Re-fetch `/auth/permissions` after a 403 `PERMISSION_DENIED`, so a revoked permission's button disappears without waiting for the next token refresh. The API already refuses it, so this is cosmetic.
5. Replace the `ctx.role === 'RESIDENT'` branches in `billing.service.ts` and `payment.service.ts` with permission checks.
6. The frontend `Permission` union is hand-copied from the backend list; nothing catches drift, while the backend has a test keeping code and database in step.
7. No Playwright coverage for role-based navigation and denial; the API tests cover the rules themselves.
