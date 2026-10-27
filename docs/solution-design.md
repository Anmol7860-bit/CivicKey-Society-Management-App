is our project inclind with this document 


Society Management Solution Design
Implementation baseline | Exact runtime behavior for all 14 stories
Backend • Database • Frontend/Figma • Notifications


Document field
Value
Document type
Technical Solution Design — Concrete Runtime Specification v4.0
Scope
14 implementation stories: Authentication, RBAC, Offline, Society/Residents/Staff, Visitor/Security, Notifications, Billing/Payments, Tasks/Reports
Audience
Tech Lead, mentor, developers, QA
Baseline stack
React + Vite + TypeScript + Tailwind + react-i18next; Node.js + Express; PostgreSQL; Socket.IO; IndexedDB; Web Push; Brevo transactional email; Razorpay hosted checkout in test mode
Cost constraint
Zero-cost local self-hosted MVP by default: local PostgreSQL and private local file storage; no Redis, S3 or managed hosting initially. Razorpay live checkout requires society merchant credentials and incurs provider transaction fees; test credentials are used in development.
Status
Version 4.0 — fixed implementation baseline and runtime scenario catalogue.

Purpose
This document is the implementation baseline for all 14 Society Management stories. It specifies fixed runtime outcomes for API processing, PostgreSQL state changes, frontend states, notification jobs, errors, concurrency, offline synchronization, and scenario tests. Implementations must produce the stated outcomes consistently; changes require a versioned Jira design/migration/test update.
Contents
Global technical standards and fixed runtime behavior
Story 1 — Authentication & Session Management (SMB-2)
Story 2 — Role-Based Access Control (RBAC)
Story 3 — Offline Support Framework
Story 4 — Society, Block & Flat Management
Story 5 — Resident & Tenant Management
Story 6 — Guard & Staff Management
Story 7 — Visitor Registration
Story 8 — Visitor Approval & Pre-Approval
Story 9 — Gate Entry & Exit
Story 10 — Staff Movement & Verification
Story 11 — Real-Time Security Notifications
Story 12 — Maintenance Billing
Story 13 — Payments & Receipts
Story 14 — Community Tasks & Reports
ERD, end-to-end integration and delivery standards
1. Global Technical Standards and Fixed Behavior
1.1 Approved baseline architecture
Layer
Technology
Responsibility / guardrail
Frontend
React, Vite, TypeScript, Tailwind CSS, react-i18next
Responsive role-based web/PWA; shared components; translated labels/errors; client-side guards improve UX but do not enforce security.
Backend
Node.js, Express
REST API, input validation, service orchestration, auth/RBAC/society scope, state transitions, audit and outbox events.
Database
PostgreSQL
System of record; constraints, indexes, foreign keys, transactions, idempotency.
Realtime
Socket.IO
Live in-app events to authorized users/rooms only; never the only source of truth.
Offline
IndexedDB + Sync Queue + Service Worker where required
Guard actions are persisted locally and retried idempotently. Offline actions must not falsely imply live approval.
Push
Web Push + VAPID
Browser/device notifications when permission and subscription exist.
Email
Brevo transactional email
Send receipt emails only after receipt PDF is READY, and billing due/overdue reminders to users with a stored email address. No visitor approvals, OTP, SMS or WhatsApp via email provider.
Payment
Razorpay hosted checkout; test mode during integration
Live checkout is enabled only when society merchant credentials and webhook secret are encrypted and configured. Webhook verification is authoritative; live transaction fees apply.

 
1.2 Role and identity model — current clarification
APPLICATION ROLES
 ADMIN
 RESIDENT
 GUARD
  
 RESIDENT relationship types: OWNER | TENANT
 ADMIN with COMMITTEE_LIMITED profile receives only the five allowlisted Committee permissions; COMMITTEE is not an application role.

 
- Roles and Committee Access: The only application roles are ADMIN, RESIDENT, and GUARD. OWNER and TENANT are time-bound flat-resident relationship types. Committee members use an ADMIN account with COMMITTEE_LIMITED access, restricted to billing rates, invoice generation, cash payment marking, and report viewing. They never inherit unrestricted admin permissions.
- Owner and Tenant Permissions: When a flat has an active tenant, the tenant receives FULL resident access, while the owner has VIEW_ONLY access to visit history and bill/payment status. The owner cannot approve visitors, create passes, pay bills, or perform other resident mutations.
- Move-Out and Access Restoration: When the tenant moves out, set the relationship's end_date to the move-out date and restore the owner's FULL resident access within the same transaction.

1.3 Common backend request pipeline
HTTP request
  request ID / safe logging
  validate access token (for protected endpoints)
  resolve user + application role
  authorize exact permission
  resolve society scope from trusted server context
  validate flat/resource scope if applicable
  validate request schema
  service: business rules + allowed state transition
  repository: parameterized SQL
  transaction: data change + audit + notification outbox where required
  response DTO (never raw DB row or secrets)

 
1.4 API conventions and error contract
Status
Meaning
Example codes
200 / 201
Successful read/update or creation
OK / CREATED
400
Malformed request or invalid transition
VALIDATION_FAILED / INVALID_STATE
401
Missing/invalid/expired authentication
UNAUTHENTICATED / TOKEN_EXPIRED / INVALID_CREDENTIALS
403
Authenticated but permission/scope denied
PERMISSION_DENIED / NOT_YOUR_FLAT
404
Resource unavailable; use for cross-society identifiers if existence must not be disclosed
NOT_FOUND
409
Conflict/idempotency/duplicate current-state constraint
CONFLICT / DUPLICATE_EVENT / ALREADY_PAID
422
Well-formed input fails domain rule
PASS_EXPIRED / STAFF_BLOCKED
429
Rate limit exceeded
RATE_LIMITED
500 / 502
Unexpected server or dependency failure
INTERNAL_ERROR / GATEWAY_UNAVAILABLE

 
{
  "error": { "code": "PERMISSION_DENIED", "message": "You are not authorized to perform this action." },
  "requestId": "<correlation-id>"
}

 
Do not return stack traces, password hashes, raw refresh tokens, provider secrets, full identity-document numbers, or payment-card data.
All SQL must be parameterized. User-supplied role, userId, societyId, or permissions must not be trusted as authorization facts.
Each mutating request must accept/emit an X-Request-Id or server-generated correlation ID. Use structured, masked logs.
1.5 Shared design rules
Controller: HTTP parsing/status/DTO only; Service: business logic; Repository: SQL; Middleware: authentication/authorization; Validator: request schema; Integration adapter: external provider boundary.
Authorization failures must stop before the business service executes. The backend is the security boundary; route hiding is only UX.
For a sensitive mutation, define a transaction boundary. Write business data + audit event + notification outbox atomically where the business action requires all three.
Use SELECT ... FOR UPDATE / conditional status updates for simultaneous approve/deny, entry/exit and online/cash payment updates. The first valid approval decision and first successful invoice settlement win.
Use database constraints to prevent duplicate passes, duplicate flat-period invoices, duplicate offline events, and duplicate gateway webhooks.
The MVP runs with Node.js/Express and PostgreSQL on the local development host or a self-hosted server; file uploads and receipt PDFs are stored in a private local directory, not a public static folder. The PWA uses same-origin REST and Socket.IO. Redis, S3, paid SMS and other managed infrastructure are not part of this implementation. Database backups are encrypted local pg_dump exports. An architecture change requires a versioned design update; it is not added silently.
 Local app/PWA responsive design targets: 360–390 px mobile, 768 px tablet, 1024 px laptop, 1280 px+ desktop. Guard-critical actions need mobile-first layout and touch targets around 44 px or more.
1.6 Common notification delivery pattern
Within business transaction:
  update domain record
  insert audit record (for auditable actions)
  insert notification_outbox event
Commit
 
Dispatcher/worker:
  read pending outbox item
  deliver in-app + authorized Socket.IO event
  attempt Web Push if subscribed
  attempt email only for configured event/provider
  persist per-channel status / retry with backoff

 
A business transaction writes the notification_outbox record atomically but does not wait for Socket.IO, Web Push or Brevo delivery. The dispatcher polls every 5 seconds, claims up to 50 items using FOR UPDATE SKIP LOCKED, writes an independent delivery record for each channel, retries at 30 seconds/2 minutes/10 minutes/1 hour and marks the channel DEAD after five attempts. Stale processing claims older than 5 minutes are reclaimed; retries never repeat the business mutation.
Socket.IO rooms must be server-assigned after validating the authenticated identity and society; never trust a client-supplied room name.
 Do not put full government ID numbers, passwords, tokens, or sensitive financial detail in notification payloads or lock-screen text.
1.7 Fixed implementation rules used by all stories
Rule
Implementation behavior
Applies to
Application roles
Exactly ADMIN, RESIDENT and GUARD. OWNER/TENANT are flat_residents relationship types. Committee is ADMIN + COMMITTEE_LIMITED + explicit active user_permissions; no unrestricted Admin grants are inherited.
All stories
Owner/tenant access
Tenant has FULL resident access while active. Owner is VIEW_ONLY for visit history and bill/payment status. Owner approval/pass/payment/write APIs return 403 while a tenant is active. Tenant move-out closes the link and restores Owner FULL access in the same transaction.
Stories 2,5,8,12,13
Visitor approval
Create one approval request for the effective FULL-access approver: active Tenant if present, otherwise FULL-access Owner. Owner receives read-only visit notice while a tenant is active. One reminder at 60 seconds; at 180 seconds set AWAITING_MANUAL. If no approver exists, go to AWAITING_MANUAL immediately. Guard Allow/Deny requires a reason; no automatic decision.
Stories 7–9,11
Visitor status
Persisted visit statuses are AWAITING_APPROVAL, AWAITING_MANUAL, APPROVED, DENIED, ENTERED, CLOSED. No-pass registration becomes AWAITING_APPROVAL when an approver exists or AWAITING_MANUAL otherwise. Valid pass or resident approval produces APPROVED; 180-second timeout produces AWAITING_MANUAL; manual ALLOW produces ENTERED; gate entry produces ENTERED; gate exit changes ENTERED to CLOSED and records VISITOR_EXITED then VISIT_CLOSED events. DENIED and CLOSED are terminal. REGISTERED is an action/event, never a persisted status.
Stories 7–9
Offline
Guard persists supported action to IndexedDB before the UI reports local save. Auto-sync starts on connectivity; Sync Now is visible. Batch max 50. Duplicate clientEventId returns DUPLICATE_IGNORED. Manual unannounced offline entry is physically ENTERED with source=MANUAL_OFFLINE, needs_review=true and no resident approval record.
Stories 3,7,9,10
Billing
Quarterly runs Jan/Apr/Jul/Oct 1; amount=round(sqft snapshot × rate effective on quarter start,2); due_date=quarter_start+15 days. Due reminder 3 days before; overdue on day 1/7/15 after due. Existing invoices immutable.
Story 12
Payment
Razorpay hosted checkout. Verify HMAC-SHA256 against raw body. Payment state changes only from signed webhook; cash requires PAYMENT_CASH_MARK and exact full invoice amount. Partial settlement disabled. One successful settlement and one receipt per invoice.
Story 13
Notifications
In-app records always persist in same transaction via outbox. Socket.IO event rooms are server-derived. Web Push only for active subscriptions. Brevo sends RECEIPT_READY, BILL_DUE_SOON and BILL_OVERDUE only. Outbox poll 5s/batch 50; retry 30s/2m/10m/1h; DEAD after 5 tries. No SMS/WhatsApp.
Story 11 and all domain stories
ID privacy
Captured IDs are encrypted using AES-256-GCM with DATA_ENCRYPTION_KEY; exact lookup uses keyed HMAC-SHA256 digest. Normal DTOs show masked last four digits only. Staff photo required; visitor photo optional; ID required only when society_settings.id_required=true.
Stories 6,7,10
Local backup
In local deployment Admin with BACKUP_EXPORT can generate an encrypted compressed PostgreSQL backup through server-side pg_dump. The download link expires after 15 minutes, operation is audited, and the API is disabled in cloud mode.
Global/Story 3
Task lifecycle
OPEN > ASSIGNED > IN_PROGRESS > COMPLETED > CLOSED. No skipped or reverse transitions. Reminder at due_at-24h and one overdue event after due_at; no reminders after COMPLETED/CLOSED.
Story 14

 
 
Configuration and time All timestamps are stored as TIMESTAMPTZ in UTC and rendered in the society timezone. The society timezone defaults to Asia/Kolkata. Background jobs use database timestamps, not process-memory timers.
Authentication Phone + password only; no OTP/SMS. Access token 30 minutes, rotating refresh token 30 days, Guard session requires re-login after 12 hours. Refresh token stored only as a hash. Reuse revokes the token family.
Login throttling Track failures by normalized phone and source IP in PostgreSQL. Failed attempt 1–4 returns 401 INVALID_CREDENTIALS. Failed attempt 5 within 15 minutes also returns 401 INVALID_CREDENTIALS and atomically starts a 15-minute phone lock; every subsequent attempt for that locked phone returns 429 RATE_LIMITED until the lock expires. Request 31 and later from one IP within a 15-minute window return 429. Successful login resets that phone failure counter; it does not reset the IP request window.
Visitor approval Every walk-in visitor/delivery without a valid pre-approved pass requires a decision from the effective FULL-access resident approver. If an active TENANT relationship exists, only that tenant can approve/deny; the owner receives a read-only visit notice. If no active tenant exists, the FULL-access owner is the approver. Send one reminder to the effective approver at 60 seconds. At 180 seconds, set AWAITING_MANUAL. The Guard must choose Allow or Deny and enter a reason; the system never auto-allows or auto-denies. If no FULL-access resident approver exists, move to AWAITING_MANUAL immediately and alert the gate and General Admin.
Offline Guard operations persist to IndexedDB before any network call. Batch sync max 50; clientEventId unique; per-event results; >24-hour client clock skew needs review; after 10 retry failures retain the event for Admin review.
Billing Quarterly maintenance invoices are generated on Jan 1, Apr 1, Jul 1 and Oct 1 in the society timezone. Amount = round(flat sqft × rate effective on the quarter start, 2). Due date is the quarter start date plus 15 calendar days (for example, Apr 1 → Apr 16). One-time charges are separate invoices due 15 calendar days after issue date.
Payment Use Razorpay hosted checkout, with test credentials in development and live credentials only in the deployment secrets. Verify HMAC-SHA256 over the raw webhook body. Full-invoice settlement only; no partial payments. Cash must equal the complete outstanding amount and requires PAYMENT_CASH_MARK. The browser return page never confirms payment. A receipt row is created only after a verified success webhook or committed authorized cash settlement; PDF creation is asynchronous.
Notification Every domain event creates an outbox row in the same transaction. In-app always; Socket.IO live; Web Push only to active subscriptions; Brevo email is sent only for RECEIPT_READY, BILL_DUE_SOON and BILL_OVERDUE, when the user has an email address; in-app and Web Push delivery remain independent. Retry at 30 seconds, 2 minutes, 10 minutes and 1 hour; DEAD after five attempts.
Data privacy No passwords, access/refresh tokens, full government ID, card data or merchant secrets in logs, browser-visible payloads, or notifications. Government ID values are encrypted at rest and masked in ordinary views.
1.8 Base schema migrations — create these before Story 1
Migration order is fixed 001_base_schema → 002_auth_sessions → 003_rbac → 004_society/flat → remaining domain migrations. Run each migration once in source control; do not execute these snippets manually against a shared environment.
-- 001_base_schema.sql — core tenancy and user identity
 CREATE EXTENSION IF NOT EXISTS pgcrypto;

 CREATE TABLE societies (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   name VARCHAR(160) NOT NULL,
   status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
     CHECK (status IN ('ACTIVE','INACTIVE')),
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   deactivated_at TIMESTAMPTZ
 );

 CREATE TABLE users (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   society_id UUID NOT NULL REFERENCES societies(id),
   display_name VARCHAR(160) NOT NULL,
   phone_normalized VARCHAR(20) NOT NULL UNIQUE,
   email VARCHAR(254),
   password_hash TEXT NOT NULL,
   status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
     CHECK (status IN ('ACTIVE','INACTIVE','LOCKED')),
   must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
   temporary_password_expires_at TIMESTAMPTZ,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   deleted_at TIMESTAMPTZ
 );
 CREATE INDEX idx_users_society_status ON users(society_id,status);

 CREATE TABLE society_settings (
   society_id UUID PRIMARY KEY REFERENCES societies(id) ON DELETE CASCADE,
   timezone VARCHAR(80) NOT NULL DEFAULT 'Asia/Kolkata',
   id_required BOOLEAN NOT NULL DEFAULT FALSE,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 -- auth_rate_limit_buckets and auth_audit_events are created in Migration 001_base_schema.sql.




Core identity, tenancy, gates and audit tables are canonical shared tables. Later stories extend them; they must not create duplicate users, gates or audit tables.
1.9 Canonical state machines — shared API/DB/UI contract
Visitor pass ACTIVE is valid only when current time is within valid_from/valid_to, status is ACTIVE, the destination matches and used_count < max_uses. Consumption increments used_count in the same transaction as visit creation; when used_count reaches max_uses, status becomes USED. Revoked or expired passes never authorize entry.
Persisted statuses AWAITING_APPROVAL, AWAITING_MANUAL, APPROVED, DENIED, ENTERED, CLOSED.
Valid pass Creates the visit with status APPROVED.
No valid pass
If an effective approver exists, set status to AWAITING_APPROVAL.
If no effective approver exists, set status to AWAITING_MANUAL.
APPROVED → ENTERED Guard records the visitor's entry.
ENTERED → CLOSED: Visit is closed after the visitor exits.
AWAITING_APPROVAL → APPROVED / DENIED Approver approves or denies the visit.
AWAITING_APPROVAL → AWAITING_MANUAL If no decision is made within 180 seconds, the visit moves to manual approval.
AWAITING_MANUAL → ENTERED / DENIED: Guard decides whether to allow or deny entry, providing a reason for the decision.
Terminal statuses: DENIED and CLOSED are final statuses; no further transitions are allowed.
Registered this is not a persisted status.
Approval request PENDING > APPROVED, DENIED, SUPERSEDED or TIMED_OUT. Only the designated current effective approver can decide, and only while PENDING. Adding/moving out a Tenant supersedes the old request and creates one request for the newly effective approver, preserving the original 60-second reminder and 180-second escalation deadlines.
Staff movement a verified, unblocked staff member with an active pass and matching active flat assignment may have one active movement. Movement status transitions ENTERED -> EXITED; duplicate entry/exit is 409. Each movement has one destination flat. The house-visit status transitions PENDING > ARRIVED > LEFT; at gate exit, unresolved PENDING/ARRIVED status becomes NOT_CONFIRMED_BY_RESIDENT without blocking gate exit.
Invoice/payment/receipt invoices begin UNPAID, become OVERDUE after due date, and become PAID only after one verified full settlement; VOID is terminal. Payment attempts transition INITIATING > CREATED > PENDING > SUCCESS or FAILED; mismatches become REVIEW_REQUIRED and leave the invoice unpaid. Settlement creates exactly one receipt row in PENDING_PDF; receipt delivery transitions to READY or FAILED without changing the settled payment.
Offline sync each queued event has a stable clientEventId and is processed in its own transaction in queue order. Server results are APPLIED, DUPLICATE_IGNORED, REJECTED, FAILED_RETRY or NEEDS_REVIEW. Only APPLIED/DUPLICATE_IGNORED remove the local queue entry; permanent errors remain visible in history, retryable errors remain queued, and NEEDS_REVIEW is retained for Admin resolution.
Community task OPEN > ASSIGNED > IN_PROGRESS > COMPLETED > CLOSED. No skip, reverse transition or reopening is allowed. An unassigned task is OPEN; one created with an assignee is ASSIGNED. Due reminder is emitted once at due_at minus 24 hours only if the task is not terminal; overdue notification is emitted once after due_at; no task reminders are sent after COMPLETED/CLOSED.
-- 001_base_schema.sql — gates, guard assignments and audit trail
 CREATE TABLE gates (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   society_id UUID NOT NULL REFERENCES societies(id),
   code VARCHAR(40) NOT NULL,
   name VARCHAR(120) NOT NULL,
   status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
     CHECK (status IN ('ACTIVE','INACTIVE')),
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   UNIQUE (society_id,code)
 );

 -- A Guard is a users row with role GUARD plus this operational profile.
 CREATE TABLE guard_profiles (
   user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
   society_id UUID NOT NULL REFERENCES societies(id),
   employee_code VARCHAR(60) NOT NULL,
   status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
     CHECK (status IN ('ACTIVE','INACTIVE')),
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   UNIQUE (society_id,employee_code)
 );
 CREATE TABLE guard_gate_assignments (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   guard_user_id UUID NOT NULL REFERENCES users(id),
   gate_id UUID NOT NULL REFERENCES gates(id),
   start_at TIMESTAMPTZ NOT NULL,
   end_at TIMESTAMPTZ,
   assigned_by UUID NOT NULL REFERENCES users(id),
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   CHECK (end_at IS NULL OR end_at > start_at),
   UNIQUE (guard_user_id,gate_id,start_at)
 );
 CREATE INDEX idx_guard_gate_active ON guard_gate_assignments(guard_user_id,gate_id,start_at,end_at);

 CREATE TABLE audit_events (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   society_id UUID REFERENCES societies(id),
   actor_user_id UUID REFERENCES users(id),
   actor_role VARCHAR(24),
   event_type VARCHAR(100) NOT NULL,
   entity_type VARCHAR(80) NOT NULL,
   entity_id UUID,
   before_data JSONB,
   after_data JSONB,
   reason TEXT,
   request_id VARCHAR(120) NOT NULL,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE INDEX idx_audit_society_time ON audit_events(society_id,created_at DESC);
 CREATE INDEX idx_audit_entity_time ON audit_events(entity_type,entity_id,created_at DESC);

 CREATE TABLE auth_audit_events (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   user_id UUID REFERENCES users(id),
   event_type VARCHAR(80) NOT NULL,
   outcome VARCHAR(24) NOT NULL,
   masked_phone VARCHAR(24),
   source_ip_hash CHAR(64),
   request_id VARCHAR(120) NOT NULL,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE INDEX idx_auth_audit_created ON auth_audit_events(created_at DESC);

 -- Persistent rate-limit buckets; bucket_key is HMAC-SHA256(IP or normalized phone), never a raw phone/IP.
 CREATE TABLE auth_rate_limit_buckets (
   bucket_key CHAR(64) PRIMARY KEY,
   bucket_type VARCHAR(12) NOT NULL CHECK (bucket_type IN ('PHONE','IP')),
   window_started_at TIMESTAMPTZ NOT NULL,
   request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
   locked_until TIMESTAMPTZ,
   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );

 -- Atomic fixed-window counter update. bucket_key = HMAC-SHA256(AUTH_RATE_KEY, "PHONE:" + normalizedPhone) or HMAC-SHA256(AUTH_RATE_KEY, "IP:" + trustedClientIP).
 INSERT INTO auth_rate_limit_buckets(bucket_key,bucket_type,window_started_at,request_count,updated_at)
 VALUES (1,2,NOW(),1,NOW())
 ON CONFLICT(bucket_key) DO UPDATE SET
   request_count = CASE WHEN auth_rate_limit_buckets.window_started_at <= NOW()-INTERVAL '15 minutes' THEN 1 ELSE auth_rate_limit_buckets.request_count+1 END,
   window_started_at = CASE WHEN auth_rate_limit_buckets.window_started_at <= NOW()-INTERVAL '15 minutes' THEN NOW() ELSE auth_rate_limit_buckets.window_started_at END,
   updated_at=NOW()
 RETURNING request_count,window_started_at,locked_until;
 -- IP bucket increments for every auth endpoint request; request 31 in the active 15-minute window receives 429.
 -- PHONE bucket increments only after failed credentials. On failure number 5, set locked_until=NOW()+INTERVAL '15 minutes'; while locked, return 429 before password verification.
 -- On successful login, reset/delete that PHONE bucket. Never store raw phone or IP values in bucket_key.




Story 1 — Authentication & Session Management (SMB-2)
Provide a common phone-number/password login, access-token authentication, refresh, logout, and session restoration across the three application roles.
Users/roles seed data; PostgreSQL; common error contract; RBAC permissions endpoint from Story 2.
Runtime behavior is specified in the Scenario Catalogue at the end of this story. The API, database state machine, UI, and tests must implement the same outcomes.
1. Backend — Node.js + Express

POST /api/v1/auth/login; 
POST /api/v1/auth/refresh; 
POST /api/v1/auth/logout; 
GET /api/v1/auth/me; 
POST /api/v1/auth/change-password; 
POST /api/v1/users (General Admin provisioning); 
POST /api/v1/users/{userId}/temporary-password (General Admin reset).
Login API — POST /api/v1/auth/login
Phone, password. Validate required fields and phone normalization before querying the DB. Following are the steps:
Validate schema
Apply the fixed IP/phone rate limit
Lookup the normalized phone
Verify bcrypt hash
Verify ACTIVE account
Resolve actual role/society from PostgreSQL
Create ACTIVE session and refresh-token hash
Issue tokens:
30-minute access token
Rotating refresh token (30-day maximum for Resident/Admin; 12-hour absolute session expiry for Guard)
Insert login audit event
Commit
Return:
Safe profile + access token in JSON
Refresh token only through the HttpOnly Set-Cookie header
Security Requirements:
No token is returned before the session transaction commits.
Unknown phone and wrong password must return the same generic 401 response.
Inactive/blocked accounts must not receive tokens.
Never store or log the raw password.
If session persistence fails, do not return a usable token pair.
Create the session before responding; ensure token creation/DB failure does not leave a partially authenticated client.
Refresh API — POST /api/v1/auth/refresh
Read the refresh token only from the HttpOnly cookie; validate signature, issuer, audience and expiry; look up its stored hash under SELECT FOR UPDATE. Check used_at BEFORE revoked_at: an already-used token is reuse and revokes the full session/token family; an expired or revoked unused token returns 401. For a valid unused token, mark it used/revoked, insert the replacement hash and link replaced_by_token_id in one transaction, then issue a new access token and replacement cookie.
Refresh-token reuse is a confirmed security incident: in one transaction revoke the entire user_sessions row and every refresh_tokens row in that session family, write a REFRESH_TOKEN_REUSE audit event, clear the refresh cookie and require a fresh login. Return 401 REFRESH_TOKEN_REUSED. Do not issue new tokens.
Logout API — POST /api/v1/auth/logout
Authenticate the logout request using the access token or current refresh-session context.
Identify the corresponding server-side session.
Revoke the session and all refresh tokens belonging to its token family.
Record the LOGOUT audit event within the same transaction.
Clear the HttpOnly refresh cookie.
Clear the in-memory access token and authentication state.
Disconnect the user's Socket.IO connection.
Return a 200 OK response.
Idempotency: Repeated logout requests for the same session return 200 OK without affecting other sessions.

Authentication middleware / GET /api/v1/auth/me
Extract Bearer access token; verify signature, expiry, issuer and audience; load the session by sid and require ACTIVE status and non-expiry on every protected request; resolve active user, role and society from trusted server-side data; attach req.auth; reject before controller on failure. GET /me returns only safe profile fields.
Routes: Receive incoming authentication requests.
Authentication Middleware: Authenticate and authorize requests.
Validators: Validate request data and input schemas.
AuthController: Handle requests and responses.
Service Layer: Use AuthService, TokenService, and SessionService to manage authentication, tokens, and sessions.
Repository Layer: Use UserRepository and SessionRepository to interact with the database.
Database: PostgreSQL stores user and session data.
Secret Management: Store secrets in environment variables or secure secret configuration, never directly in source code.

2. Database — PostgreSQL (DDL/DML)
Core tables users, roles, user_roles, user_sessions and auth_audit_events. Successful and failed login attempts are audited with safe metadata; passwords/tokens are never stored in the audit payload.


CREATE TABLE IF NOT EXISTS user_sessions (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   user_id UUID NOT NULL REFERENCES users(id),
   token_family_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
   status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
     CHECK (status IN ('ACTIVE','REVOKED','EXPIRED')),
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   expires_at TIMESTAMPTZ NOT NULL,
   revoked_at TIMESTAMPTZ,
   last_used_at TIMESTAMPTZ
 );
 CREATE INDEX IF NOT EXISTS idx_sessions_user_status ON user_sessions(user_id, status);
 CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON user_sessions(expires_at);

 CREATE TABLE IF NOT EXISTS refresh_tokens (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   session_id UUID NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
   token_hash TEXT NOT NULL UNIQUE,
   issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   expires_at TIMESTAMPTZ NOT NULL,
   used_at TIMESTAMPTZ,
   revoked_at TIMESTAMPTZ,
   replaced_by_token_id UUID REFERENCES refresh_tokens(id),
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session ON refresh_tokens(session_id, expires_at);

 -- Additive fields used by the fixed user onboarding flow.
 ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS temporary_password_expires_at TIMESTAMPTZ;




 
Login lookup (parameterized):
SELECT u.id, u.phone_normalized, u.password_hash, u.status, u.society_id
 FROM users u
 WHERE u.phone_normalized = $1 AND u.deleted_at IS NULL;

 
Create one session after successful verification; persist only refresh-token hash/identifier, never raw refresh token. For rotation, update old token/session state and insert the replacement in one transaction.
Logout DML example:
UPDATE user_sessions
SET status = 'REVOKED', revoked_at = NOW()
WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE';

 
Phone numbers are normalized to +91 plus ten digits and uniquely identify a user globally. PostgreSQL enforces UNIQUE(users.phone_normalized); a single user may have multiple date-bounded flat_residents relationships within the same society.
3. Frontend — React/Vite/Tailwind/react-i18next
Screens/Figma frames common Login with Resident/Guard/Admin portal selector; force-change-password screen for temporary onboarding password; empty/validation state; submitting/loading; invalid credentials; portal-role mismatch; inactive account; network/server error; successful role route; restoring session; session expired; logout; unauthorized (403). Use mobile 360–390, tablet 768 and desktop 1280+ frames. Logout executes immediately; no confirmation dialog is required.
Wireframe phone input + password input + show/hide password + submit + inline field errors + global error region. Do not require separate login implementations per role.
Validate all required fields on submission.
Call the login API with the selected portal value.
Backend validates that the selected portal matches the user’s role stored in PostgreSQL.
On successful login Store the access token in in-memory authentication state.
Use the HttpOnly refresh cookie to manage token refresh.
Retrieve /auth/me to fetch the authenticated user’s details.
Retrieve /auth/permissions to fetch the user’s permissions.
Redirect the user based on the role returned by the backend.
The portal selector never assigns, changes, or overrides the user’s role.
Refresh-token transport is fixed use an HttpOnly, Secure, SameSite=Strict cookie scoped to /api/v1/auth. On HTTPS deployments set Secure=true; local development may disable Secure only on localhost. Keep the 30-minute access token in memory, not localStorage. Validate the Origin header on state-changing auth requests and use a same-origin Vite proxy in development.
On 401, attempt one refresh only when appropriate; prevent refresh loops; if refresh fails, clear auth state and route to Login. On 403, show Access Denied and do not assume the UI check alone secures the resource.
Use react-i18next for labels and error codes; never hardcode API error strings across screens. Add keyboard accessibility and visible focus states.
4. Notifications — Socket.IO / Web Push / Brevo transactional email
No external notification is required for core login/logout. Do not send paid SMS/OTP; the BRD flow is phone + password.
Audit successful and failed login attempts with user/session reference, source IP, requestId and outcome; never log passwords, tokens or secrets. No external notification is sent for normal login/logout.
On logout/session expiry, disconnect authenticated sockets and clear local notification state. The server must reject events from expired/revoked sessions where session checks are enabled.
Acceptance / review checklist
Valid login yields one active session and a role sourced from trusted backend data.
Unknown phone/wrong password fail without tokens; inactive user cannot log in.
No token / malformed / invalid signature / expired token returns 401 before controller execution.
Refresh rejects expired, revoked, already-used, unknown and malformed refresh tokens. Reuse of a previously rotated token revokes the entire session/token family and requires fresh login.
Logout marks the session revoked; refresh using the old token fails.
Passwords are hashed; secrets/token values are not logged or returned in unsafe fields.
Rate limiting is demonstrated, not merely stated in code.
 
Runtime Scenario Catalogue — Story 1 — Authentication & Session Management (SMB-2)
Use these exact cases for implementation review and QA. Each row defines the trigger, backend/database outcome, HTTP/UI result and required side effect. A case passes only when the observable response and persisted state match.

Scenario / trigger
Backend and database behavior
Expected response, UI and side effects
AUTH-01 | Successful role login
POST /auth/login with a valid phone/password and selected portal. Load user, active account state and server-assigned application role; create one ACTIVE session; store only a hash of the rotating refresh token.
Return 200 with safe profile, backend role and 30-minute access token in JSON. Set the rotating refresh token only in an HttpOnly, Secure, SameSite=Strict cookie; never include it in JSON. Guard cookie/session expiry is capped at 12 hours. UI routes to the backend-authorized dashboard. A GUARD session expires at the 12-hour shift boundary and requires login again.
AUTH-02 | Selected portal does not match assigned role
Credentials are first verified; compare the UI-selected portal to the role resolved from PostgreSQL. Never use the posted portal value as the actual role.
Return 403 ROLE_MISMATCH with no tokens/session. Keep the login form visible and show a localized portal mismatch message.
AUTH-03 | Unknown phone or wrong password
Normalize phone, apply rate limit, perform parameterized user lookup, and verify bcrypt hash. Audit a failed attempt without storing the password.
Return the same 401 INVALID_CREDENTIALS response for unknown phone and wrong password. No session or token is created.
AUTH-04 | Inactive or blocked user
Load account status before session creation.
Return 401 ACCOUNT_UNAVAILABLE with no tokens. Audit the internal reason; do not expose sensitive status information in public logs or response payload.
AUTH-05 | Missing or malformed input
Validate phone/password and phone format before database access.
Return 400 VALIDATION_FAILED with field-level errors. UI highlights fields; no authentication query runs.
AUTH-06 | Access token expired
Authentication middleware validates signature, issuer, audience, exp and active session before a protected controller.
Return 401 TOKEN_EXPIRED. Frontend attempts exactly one refresh; if refresh succeeds it replays the original request once, otherwise clears auth state and redirects to login.
AUTH-07 | Refresh token rotation
Validate token and ACTIVE session, check expiry and token hash, then in one transaction revoke old token identifier and insert replacement hash.
Return 200 with a new access token in JSON and the replacement refresh token in Set-Cookie. The previous refresh-token row is marked used/revoked and cannot be reused.
AUTH-08 | Expired, revoked or reused refresh token
Look up the presented refresh-token hash. If used_at is already set, treat it as confirmed reuse: atomically revoke the entire session family and related refresh tokens, write REFRESH_TOKEN_REUSE audit, and reject. If the token is expired or revoked but not reused, reject it as TOKEN_EXPIRED or TOKEN_REVOKED without misclassifying it as a reuse incident. If its session is revoked, reject all tokens in that session. No branch issues new tokens.
Return 401 with TOKEN_EXPIRED, TOKEN_REVOKED or REFRESH_TOKEN_REUSED as appropriate; clear the refresh cookie and client auth state, and require login. Only confirmed reuse triggers the family-revocation security response. No protected operation continues.
AUTH-09 | Logout
Identify the current session from the authenticated context; update ACTIVE to REVOKED with revoked_at; invalidate refresh token; write audit in the same transaction.
Return 200 even if the same session is already revoked. Client clears auth and disconnects Socket.IO. Refresh after logout returns 401.
AUTH-10 | Login brute-force threshold
Track failed attempts by normalized phone and source IP in PostgreSQL. Failed attempts 1–5 return the same 401 INVALID_CREDENTIALS; attempt 5 atomically starts a 15-minute lock for that phone. Any later request for that locked phone returns 429 RATE_LIMITED. More than 30 auth requests from one IP in a rolling 15-minute window return 429.
Attempt 5 returns 401 and starts the lock; requests 6 onward during the lock return 429 with Retry-After seconds. Successful login resets the phone failure counter, not the IP request window. The UI shows a generic retry-later message and never reveals whether a phone exists.
AUTH-11 | Session/database write failure
If session persistence or refresh-hash insert fails, roll back the transaction and do not return a usable token pair.
Return 503 AUTH_TEMPORARILY_UNAVAILABLE with requestId. UI keeps entered phone, clears password only per form security standard, and offers retry.
AUTH-12 | GET /auth/me
Validate access token and active user/session; return only id, display name, phone mask, role, societyId and account status.
Return 200 for active user; 401 for invalid session. Password hash, refresh hash, raw tokens and secrets are never serialized.
AUTH-13 | First login with temporary password
After credential validation, if users.must_change_password=true or the temporary password is expired, restrict the session to GET /auth/me, POST /auth/change-password and POST /auth/logout. Temporary password expires 24 hours after issue.
Expired temporary password returns 401 TEMP_PASSWORD_EXPIRED and requires General Admin reset. Valid temporary password routes directly to Change Password; password must be 12+ chars and different from the temp value. Until changed, all domain APIs return 403 PASSWORD_CHANGE_REQUIRED.
AUTH-14 | Admin resets forgotten password
General Admin uses POST /api/v1/users/{userId}/temporary-password; service checks USER_MANAGE/same society, sets a new bcrypt hash, must_change_password=true, temporary_password_expires_at=now+24h and revokes all active sessions.
Return the temporary password one time to the authorized Admin with a warning to hand it to the user out-of-band. Never send SMS/email. The user must change it on next login.

Tech Lead exit check: demonstrate one positive case, one authorization failure, one state/validation failure, and one retry/concurrency case from this catalogue. Attach sanitized request/response and database-state evidence to the Jira subtask.
Admin account-provisioning APIs are part of the authentication slice because public signup is disabled. POST /api/v1/users requires USER_MANAGE, creates a user and user_roles row in one transaction, generates a cryptographically random temporary password, stores only its bcrypt hash, sets must_change_password=true and temporary_password_expires_at=NOW()+24 hours, and returns the temporary password once over HTTPS for handoff outside the application. POST /api/v1/auth/change-password requires the temporary-password session, validates a 12+ character password different from the temporary value, updates the hash, clears the temporary-password fields, audits the change, and invalidates all other sessions. Admin reset revokes every active session for that user.
Story 2 — Role-Based Access Control (RBAC)
Objective: Enforce the same role/permission rules in navigation and backend APIs, including resident flat scope and Committee-specific permission assignments.
Dependencies: Story 1 authentication; societies/flats/resident links; audit service.
Runtime behavior is specified in the Scenario Catalogue at the end of this story. The API, database state machine, UI, and tests must implement the same outcomes.
1. Backend — Node.js + Express
Core middleware: authenticate()
load effective role/permissions
requirePermission(code)
requireSocietyScope()
requireFlatAccess() where required
controller/service.
GET /api/v1/auth/permissions

Validate the authentication token.
Resolve one active application role from the user’s roles.
If the role is ADMIN:
Load the corresponding admin_access_profiles record.
Fail closed if the access profile is missing.
If the role is GENERAL_ADMIN:
Load permissions from role_permissions.
If the role is COMMITTEE_LIMITED:
Load only allowlisted, active permissions from user_permissions.
If the role is RESIDENT:
Load every active flat_residents record for the user.
Return flat-specific relationship_type, access_level, and permissions for each record.
Return the following response fields:
user
role
accessProfile
flatAccess[]
Effective permission codes
Keep the operation read-only; no transaction is required.

Protected domain API authorization
Every route declares its required permission. Examples POST /api/v1/visits requires VISIT_REGISTER; POST /api/v1/approval-requests/{id}/respond requires VISITOR_APPROVE; POST /api/v1/visits/{id}/decision requires VISIT_GATE_DECIDE; POST /api/v1/visits/{id}/entry requires VISIT_ENTRY; POST /api/v1/visits/{id}/exit requires VISIT_EXIT; GET /api/v1/invoices uses BILL_VIEW_OWN plus flat scope.
When the permission is absent, return 403 and stop before service/repository mutation. Do not trust role/permission/societyId from request body, query string, or frontend state.
Flat and society scope
For every resident request, verify the flat belongs to the authenticated society and the user has a date-active flat_residents row. A Tenant has FULL resident access while the relationship is active. An Owner has FULL access only when no active Tenant is linked. While a Tenant is active, Owner is VIEW_ONLY for visit history and bill/payment status; VISITOR_APPROVE, pass creation, payment and all other resident mutations return 403. When the Tenant moves out, the ResidentLinkService closes the tenant row and restores the owner access_level=FULL in one transaction.
Committee access assignment
An authorized General Admin selects a same-society resident, assigns the ADMIN application role with COMMITTEE_LIMITED access profile, and grants only BILLING_RATE_SET, INVOICE_GENERATE, INVOICE_ONE_TIME_CREATE, PAYMENT_CASH_MARK, and REPORT_VIEW. The effective-permissions resolver ignores General Admin role grants for COMMITTEE_LIMITED accounts. Every grant and revocation records grantor, timestamp, and audit event.
Low-level design: PermissionCatalog, AuthorizationService, requirePermission(permissionCode), requireFlatAccess(flatId), requireSocietyScope. Centralize definitions; do not repeat ad hoc role comparisons in every controller.
2. Database — PostgreSQL (DDL/DML)
Use roles/user_roles for exactly one application role, admin_access_profiles for GENERAL_ADMIN versus COMMITTEE_LIMITED, role_permissions for general role grants, and user_permissions for audited Committee-specific grants. The schema and seed data below are authoritative; do not create separate OWNER, TENANT or COMMITTEE roles.
CREATE TABLE IF NOT EXISTS roles (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   code VARCHAR(24) NOT NULL UNIQUE CHECK (code IN ('ADMIN','RESIDENT','GUARD')),
   name VARCHAR(80) NOT NULL
 );
 CREATE TABLE IF NOT EXISTS user_roles (
   user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
   role_id UUID NOT NULL REFERENCES roles(id),
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE TABLE IF NOT EXISTS admin_access_profiles (
   user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
   profile_code VARCHAR(30) NOT NULL CHECK (profile_code IN ('GENERAL_ADMIN','COMMITTEE_LIMITED')),
   assigned_by UUID NOT NULL REFERENCES users(id),
   assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE TABLE IF NOT EXISTS permissions (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   code VARCHAR(100) NOT NULL UNIQUE,
   description TEXT NOT NULL,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE TABLE IF NOT EXISTS role_permissions (
   role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
   permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   PRIMARY KEY (role_id, permission_id)
 );
 CREATE TABLE IF NOT EXISTS user_permissions (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
   granted_by UUID NOT NULL REFERENCES users(id),
   granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   revoked_at TIMESTAMPTZ
 );
 CREATE UNIQUE INDEX IF NOT EXISTS uq_active_user_permission
   ON user_permissions(user_id, permission_id) WHERE revoked_at IS NULL;

 INSERT INTO roles(code,name) VALUES
  ('ADMIN','Society Administrator'),('RESIDENT','Resident'),('GUARD','Security Guard')
 ON CONFLICT (code) DO NOTHING;
 INSERT INTO permissions(code,description) VALUES
  ('SOCIETY_MANAGE','Manage society, blocks and flats'),
  ('USER_MANAGE','Provision users and manage resident links'),
  ('STAFF_MANAGE','Manage society staff and guard records'),
  ('STAFF_MANAGE_OWN','Register/link daily help for own flat'),
  ('BILLING_RATE_SET','Set the effective-dated quarterly rate'),
  ('INVOICE_GENERATE','Generate quarterly invoices'),
  ('INVOICE_ONE_TIME_CREATE','Create a one-time charge per selected flat'),
  ('PAYMENT_CASH_MARK','Record a full cash settlement'),
  ('REPORT_VIEW','View administration reports'),
  ('AUDIT_VIEW','View audit logs'),
  ('BACKUP_EXPORT','Export an encrypted local database backup'),
  ('VISITOR_BLOCK_MANAGE','Manage society blocked visitor phone records'),
  ('VISIT_REGISTER','Register a visitor at an assigned gate'),
  ('VISITOR_APPROVE','Approve/deny a visitor for an authorized flat'),
  ('VISIT_GATE_DECIDE','Make a manual gate decision after timeout'),
  ('VISIT_ENTRY','Record authorized visitor entry'),
  ('VISIT_EXIT','Record visitor exit'),
  ('PASS_VALIDATE','Validate a visitor pass'),
  ('VISITOR_PASS_CREATE','Create/revoke own-flat visitor passes'),
  ('VISIT_VIEW_OWN','View visits for authorized flats'),
  ('VISIT_HISTORY_VIEW','Search society gate history'),
  ('BILL_VIEW_OWN','View own-flat bills and ledger'),
  ('BILL_PAY','Pay an own-flat invoice'),
  ('RECEIPT_VIEW_OWN','View own-flat receipts'),
  ('STAFF_VALIDATE','Validate staff passes'),
  ('STAFF_MOVEMENT','Record staff entry/exit'),
  ('TASK_MANAGE','Create/assign/update community tasks'),
  ('NOTIFICATION_READ','Read/mark own notifications')
 ON CONFLICT (code) DO NOTHING;

 -- Seed General Admin permissions.
 INSERT INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
 WHERE r.code='ADMIN' AND p.code IN (
  'SOCIETY_MANAGE','USER_MANAGE','STAFF_MANAGE','BILLING_RATE_SET','INVOICE_GENERATE',
  'INVOICE_ONE_TIME_CREATE','PAYMENT_CASH_MARK','REPORT_VIEW','AUDIT_VIEW','BACKUP_EXPORT',
  'VISITOR_BLOCK_MANAGE','VISIT_HISTORY_VIEW','TASK_MANAGE','NOTIFICATION_READ')
 ON CONFLICT DO NOTHING;
 -- Seed Guard permissions.
 INSERT INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
 WHERE r.code='GUARD' AND p.code IN (
  'VISIT_REGISTER','VISIT_GATE_DECIDE','VISIT_ENTRY','VISIT_EXIT','PASS_VALIDATE',
  'VISIT_HISTORY_VIEW','STAFF_VALIDATE','STAFF_MOVEMENT','NOTIFICATION_READ')
 ON CONFLICT DO NOTHING;
 -- Seed Resident permissions; flat/tenant/owner scope is enforced separately for every requested flat.
 INSERT INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
 WHERE r.code='RESIDENT' AND p.code IN (
  'VISITOR_APPROVE','VISITOR_PASS_CREATE','VISIT_VIEW_OWN','BILL_VIEW_OWN','BILL_PAY',
  'RECEIPT_VIEW_OWN','STAFF_MANAGE_OWN','NOTIFICATION_READ')
 ON CONFLICT DO NOTHING;

 -- COMMITTEE_LIMITED does not inherit general administrative role_permissions. AuthorizationService grants only the five administrative permissions from user_permissions; active flat_residents relationships separately enable own-flat Resident self-service APIs under the same tenant/owner rules:
 -- BILLING_RATE_SET, INVOICE_GENERATE, INVOICE_ONE_TIME_CREATE, PAYMENT_CASH_MARK, REPORT_VIEW.




 
SELECT p.code
 FROM user_permissions up
 JOIN permissions p ON p.id = up.permission_id
 WHERE up.user_id = $1
   AND up.revoked_at IS NULL
 ORDER BY p.code;

 -- Grant: INSERT a new user_permissions row with granted_by/current timestamp.
 -- Revoke: UPDATE that row SET revoked_at=NOW(); never delete grant history.
 -- Regrant creates a new row because the active-grant partial unique index allows history.




 
Effective permissions must be calculated conditionally in AuthorizationService. If role=ADMIN and the approved assignment profile is GENERAL_ADMIN, load role_permissions. If role=ADMIN and profile is COMMITTEE_LIMITED, load only active user_permissions from the approved Committee permission allowlist; never union in unrestricted Admin grants. For RESIDENT/GUARD, load normal role grants plus any specifically approved additive grants.
SELECT p.code
 FROM user_permissions up
 JOIN permissions p ON p.id = up.permission_id
 WHERE up.user_id = $1 AND up.revoked_at IS NULL
 ORDER BY p.code;

 CREATE TABLE IF NOT EXISTS backup_export_jobs (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   society_id UUID NOT NULL REFERENCES societies(id),
   requested_by UUID NOT NULL REFERENCES users(id),
   status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
     CHECK (status IN ('PENDING','RUNNING','READY','FAILED','EXPIRED')),
   encrypted_file_path TEXT,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   completed_at TIMESTAMPTZ,
   expires_at TIMESTAMPTZ,
   error_code VARCHAR(80)
 );
 CREATE INDEX idx_backup_export_requester ON backup_export_jobs(requested_by,created_at DESC);
 -- Only self-hosted mode supports this endpoint. The server invokes pg_dump with fixed, server-owned arguments,
 -- encrypts the archive, and creates a single-use download link expiring after 15 minutes. Never accept shell arguments from the request.




 
Seed the three roles, full permission catalogue and role_permissions in the versioned migration below. Permission codes are shared by frontend visibility and backend enforcement; the backend is authoritative. Committee-limited Admins receive only the five allowlisted personal grants and never inherit general Admin role grants.
3. Frontend — React/Vite/Tailwind/react-i18next
Figma frames Resident dashboard, Guard dashboard (mobile-first), Admin dashboard, Admin with limited Committee permissions, permission loading, unauthorized 403, API access denied, direct unauthorized URL, empty state.
After authentication, fetch /auth/permissions and store normalized permission codes in auth state. Render menu/actions based on permissions; wrap routes with a shared RequirePermission component; show a stable loading screen while permission data is loading.
Hide unauthorized actions for usability, but handle server 403 regardless of whether the button was hidden. On permissions change/logout, clear cached role/permission data.
Resident screens must scope visits, bills and passes to authorized flat relationships. If resident has multiple flats, provide an explicit selected-flat context and validate it again on backend.
Figma must label each menu/action with the permission code in the design notes for engineering traceability. Avoid maintaining a separate hardcoded permission matrix per page.
4. Notifications — Socket.IO / Web Push / Email
No notification is required for normal permission evaluation. Audit Committee access grants/revocations and sensitive permission changes.
If a permission grant changes live access, invalidate cached effective permissions or require a reload/token refresh. Do not rely on a stale Socket.IO room membership as authorization.
Use in-app audit/admin events only as specified in the permission/event rules below; never email a full permission list unless there is an explicit administrative need.
Acceptance / review checklist
Only ADMIN, RESIDENT, GUARD are application roles; owner/tenant are relationship types.
Backend checks the exact permission on every protected endpoint.
Resident flat relationship and society scope are validated server-side.
Frontend hiding a control does not replace API enforcement.
Committee-specific access is least-privilege and auditable.
Unauthorized APIs return 403 and stop before business mutation.
 
Runtime Scenario Catalogue — Story 2 — Role-Based Access Control (RBAC)
Use these exact cases for implementation review and QA. Each row defines the trigger, backend/database outcome, HTTP/UI result and required side effect. A case passes only when the observable response and persisted state match.

Scenario / trigger
Backend and database behavior
Expected response, UI and side effects
RBAC-01 | General Admin action
Resolve role=ADMIN and access profile=GENERAL_ADMIN, then check the exact required permission.
Continue only when permission is present. Record sensitive changes in audit. The UI renders only actions returned by /auth/permissions.
RBAC-02 | Committee-limited Admin action
Resolve ADMIN + COMMITTEE_LIMITED. For administrative requests, load only active user_permissions allowlisted to BILLING_RATE_SET, INVOICE_GENERATE, INVOICE_ONE_TIME_CREATE, PAYMENT_CASH_MARK and REPORT_VIEW; do not union General Admin role_permissions. Separately resolve own-flat Resident self-service permissions from active flat_residents relationships, subject to tenant/owner access rules.
Granted action proceeds within society scope. Any unrelated Admin function returns 403 PERMISSION_DENIED.
RBAC-03 | Resident accesses own flat
Resolve active flat_residents row for user/flat with start_date <= today and end_date IS NULL; enforce owner/tenant access rule for the requested operation.
Authorized own-flat operation proceeds; view-only owner write attempt returns 403. Query remains scoped to the authorized flat.
RBAC-04 | Resident requests another flat
Look up flat within the authenticated society and verify active user-to-flat relationship.
Return 403 NOT_YOUR_FLAT (or 404 for cross-society resource identifiers); do not return the protected record and do not call mutation service.
RBAC-05 | Tenant active; owner attempts write
Use active TENANT link to grant tenant FULL flat-scoped permissions. Owner retains read-only visit/bill/payment status; VISITOR_APPROVE, pass creation, checkout and all other mutations are denied.
Return 403 PERMISSION_DENIED for owner approval/pass/payment/write calls. When tenant end_date is set, owner FULL resident permissions are restored without recreating the account.
RBAC-06 | Guard accesses resident or finance API
Check GUARD permissions and gate assignment. Guard permissions cover visitor registration, pass validation, gate decision/entry/exit, staff verification and movement.
Billing, resident account management and admin reports return 403. No data mutation occurs.
RBAC-07 | UI bypass/direct API call
Call a protected endpoint directly without using the frontend navigation. Backend executes authenticate -> permission -> society scope -> flat scope -> state check.
Unauthorized operation returns 401 or 403 before controller/service mutation; hidden buttons are not treated as security.
RBAC-08 | Cross-society identifiers
Attempt an object ID belonging to another society. Bind societyId from authenticated server context, not request body.
Return 404 NOT_FOUND to avoid disclosing another society’s record existence; log an access-denial audit event.
RBAC-09 | Committee grant/revoke
General Admin grants only allowlisted permissions to a same-society eligible user and records granted_by/granted_at. Revocation sets revoked_at.
Effective permissions change on the next API request; caches/socket rooms are invalidated. Resident identity and flat history remain unchanged.
RBAC-10 | Approval vs gate decision
Require VISITOR_APPROVE for resident decision and VISIT_GATE_DECIDE for guard gate decision; never alias these codes.
Resident cannot record physical entry; Guard cannot impersonate resident approval. Separate audit actors and timestamps are stored.

Tech Lead exit check demonstrate one positive case, one authorization failure, one state/validation failure, and one retry/concurrency case from this catalogue. Attach sanitized request/response and database-state evidence to the Jira subtask.
Story 3 — Offline Support Framework
Objective Allow supported guard workflows to be recorded locally and synchronized safely after connectivity returns, without duplicating or falsely approving actions.
Dependencies: Authentication/RBAC; visitor registration and gate entry/exit; staff movement; IndexedDB; online APIs.
Runtime behavior is specified in the Scenario Catalogue at the end of this story. The API, database state machine, UI, and tests must implement the same outcomes.
1. Backend — Node.js + Express
POST /api/v1/sync/events
Payload: batchId plus events containing clientEventId (UUID), deviceId, eventType, entity/client identifiers, clientTs, payload, local sequence number and localAttemptCount. If localAttemptCount reaches 10, the event is submitted as NEEDS_REVIEW for Admin review and is not applied automatically. Each event is independently accepted/rejected so one bad item does not block the entire batch.


Authenticate the guard/device.
Verify that the guard is active and authorized for the specified society and gate.
Validate the batch size and event schema.
Process each event in a deterministic order.
Check clientEventId to determine whether the event has already been processed.
If the event was previously processed, return the stored result.
Validate current authorization and event business rules.
Execute the operation within a transaction and record the processed event.
Return an individual status for each event:
SYNCED – Event processed successfully.
DUPLICATE – Event was already processed.
RETRYABLE_FAILURE – Event failed temporarily and can be retried.
PERMANENT_FAILURE – Event failed due to an unrecoverable error.
NEEDS_REVIEW – Event requires manual review.



Duplicated events never create duplicate visit/movement rows. If a dependent visit has not been applied yet, return FAILED_RETRY and preserve ordering for the next batch. After 10 unsuccessful retries, the next reachable sync submits the event as NEEDS_REVIEW for Admin; do not delete the event. Store client_ts and server_ts. Clock skew greater than 24 hours becomes NEEDS_REVIEW.
Offline approval restriction: the guard device never creates a resident approval record while disconnected. An unannounced visitor admitted manually during an outage is recorded as a physical ENTERED visit with source=MANUAL_OFFLINE and needs_review=true; resident_decision_by remains NULL. A cached pre-approved pass is accepted offline only while its cached validity window is current and its last server sync is no more than 15 minutes old; sync revalidates live pass state, usage and event order.
Low-level design: SyncController > SyncService > IdempotencyRepository + domain services. Client: offlineQueue.enqueue > IndexedDB > syncManager.flush > per-event reconciliation.
2. Database — PostgreSQL (DDL/DML)
Keep IndexedDB as device-local queue; PostgreSQL stores server-side processed event keys and sync outcomes.
CREATE TABLE IF NOT EXISTS processed_client_events (
   client_event_id UUID PRIMARY KEY,
   user_id UUID NOT NULL REFERENCES users(id),
   device_id VARCHAR(120) NOT NULL,
   event_type VARCHAR(80) NOT NULL,
   result_status VARCHAR(30) NOT NULL CHECK (result_status IN ('APPLIED','DUPLICATE_IGNORED','FAILED_RETRY','REJECTED','NEEDS_REVIEW')),
   result_payload JSONB,
   client_ts TIMESTAMPTZ,
   server_ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE INDEX IF NOT EXISTS idx_processed_events_user_time
   ON processed_client_events(user_id, server_ts DESC);
 -- Final-result handling: APPLIED/DUPLICATE_IGNORED/REJECTED/NEEDS_REVIEW are replayed without reapplying; FAILED_RETRY is eligible for another attempt.

 
INSERT INTO processed_client_events
(client_event_id, user_id, event_type, result_status, client_ts)
VALUES ($1, $2, $3, 'SYNCED', $4)
ON CONFLICT (client_event_id) DO NOTHING;

 
Each event is applied in its own PostgreSQL transaction: write the business mutation, visit/staff event history, audit row and processed_client_events result atomically. A duplicate clientEventId returns the stored first result. Validation/state errors are persisted as REJECTED (permanent); database/network errors roll back the business transaction and return FAILED_RETRY. Keep retrying FAILED_RETRY with exponential backoff; after 10 attempts move the record to NEEDS_REVIEW and surface it in Admin review.
3. Frontend — React/Vite/Tailwind/react-i18next
Figma frames: Guard Home online, offline banner, action saved locally, queued badge/count, syncing, all synced, partial failures, retry/manual sync, duplicate rejected, needs review, empty history, stale cached pass warning.
Use IndexedDB for durable queue entries; do not rely only on in-memory state or localStorage for queued mutations. Generate a UUID clientEventId once at creation and keep it unchanged across retries.
Validate the guard action locally.
Write the event to IndexedDB.
If offline, immediately display: “Saved on this device — waiting to sync.”
When online, sync the event in the background.
Reconcile each server response.
Update the queue state accordingly.
Provide both automatic background sync and a visible Sync Now button on Guard Home. Show pending/syncing/synced/failed counts and last sync time. Do not show Approved or Entered until a server-accepted result or valid cached-pass offline event state is explicitly represented.
Handle app reload/browser restart: restore pending queue, retry with backoff, avoid infinite retry on permanent validation errors, and let a guard inspect actionable failures.
4. Notifications — Socket.IO / Web Push / Email
While offline, remote notifications cannot be guaranteed. Queue local UI status only; do not pretend a Socket.IO/Web Push event has arrived.
After server accepts a synchronized event, write a notification outbox item and dispatch only once using event/idempotency correlation. De-duplicate retries at outbox/event level.
Push/email delivery failures must not cause the accepted visit or movement event to be applied again.
Acceptance / review checklist
Every guard action is inserted into IndexedDB before the UI reports Saved locally. Auto-sync starts when online; a visible Sync Now button lets the Guard request immediate reconciliation. The UI labels local action as Pending sync until the server returns APPLIED or DUPLICATE_IGNORED.
Retry with same clientEventId does not duplicate a visit/movement.
Partial batch failures are reported per event.
Client timestamp and server timestamp are both stored for the endpoints and events specified below.
Offline does not mark an unapproved visitor as specified in the fixed event map in Section 1.6/authorized.
Queue survives refresh/restart and auto-sync resumes when connected.
 
Runtime Scenario Catalogue — Story 3 — Offline Support Framework
Use these exact cases for implementation review and QA. Each row defines the trigger, backend/database outcome, HTTP/UI result and required side effect. A case passes only when the observable response and persisted state match.
Scenario / trigger
Backend and database behavior
Expected response, UI and side effects
OFF-01 | Guard performs an online action
Guard action is written to IndexedDB with clientEventId before attempting background sync; UI immediately marks local state.
UI shows Saved locally / Syncing / Synced. Server applies event once; client removes queue row only after APPLIED or DUPLICATE_IGNORED result.
OFF-02 | Network unavailable during visitor entry/exit
Persist supported visitor registration, gate entry/exit and staff movement events in IndexedDB in creation order.
UI remains usable and shows Pending sync; no screen claims that a resident approved an unannounced visitor while offline.
OFF-03 | Cached valid pass used offline
Use a server-validated pass cache whose last successful refresh was within 15 minutes and whose valid_from/valid_to window includes the current local timestamp. Cached state never overrides a later online revocation detected during sync. Save the pass ID/code digest reference and event timestamp with the local event.
UI marks action Offline recorded. On sync, backend revalidates authorization and event order; clock anomalies or validity conflicts mark NEEDS_REVIEW, not silently approved.
OFF-04 | Unannounced visitor while offline
Record a MANUAL_OFFLINE gate event with guard ID, gate, reason, client timestamp and needs_review=true. Do not create a fabricated resident approval.
UI clearly shows Manual/offline—review required. After sync the event is visible to Admin and produces an audit record; resident approval status remains absent.
OFF-05 | Automatic batch sync
When navigator is online, refresh authentication once if needed and POST at most 50 ordered events to /api/v1/sync/events. APPLIED, DUPLICATE_IGNORED, and REJECTED are final; FAILED_RETRY is retried with backoff; NEEDS_REVIEW is retained for Admin resolution and never automatically applied.
Return a per-event result. APPLIED and DUPLICATE_IGNORED rows are removed from IndexedDB; retryable failures remain queued.
OFF-06 | Duplicate batch/replay
Server inserts clientEventId into processed_client_events under unique constraint before applying the business effect in the transaction.
Repeated event returns DUPLICATE_IGNORED and never creates a second visit/movement or notification.
OFF-07 | One invalid event inside batch
Validate and apply each event in its own transaction; do not roll back unrelated valid events in the batch.
Return REJECTED with exact domain code for permanent errors and FAILED_RETRY for transient failures. UI shows per-item state.
OFF-08 | Stale client clock or unknown target
Compare clientTs against server time. If skew exceeds 24 hours, flag NEEDS_REVIEW; if a dependent visit has not synced yet, retain the event for retry in sequence.
Do not apply a state transition with an unresolved dependency. Retry with backoff; after 10 failed retries mark Needs Admin Review and retain evidence.
OFF-09 | Browser reload/device restart
Queue and sync metadata persist in IndexedDB, not only React state. Service worker/background sync invokes the same sync manager when connectivity returns.
Queued actions survive reload and are visible on Guard Home with counts and last successful sync time.
OFF-10 | Export local database backup
Only in DEPLOYMENT_MODE=local and with BACKUP_EXPORT, create a backup job using server-side execFile(pg_dump) with fixed arguments, compress and encrypt the dump using BACKUP_ENCRYPTION_KEY, write an audit row, and store the artifact outside the public web root.
Return a job ID; UI shows generating/ready/failed. Ready download URL expires after 15 minutes and rechecks the caller permission. A deployment marked cloud mode returns 404; missing key/pg_dump errors return a safe 503 and preserve an Admin-visible failure record.

Tech Lead exit check: demonstrate one positive case, one authorization failure, one state/validation failure, and one retry/concurrency case from this catalogue. Attach sanitized request/response and database-state evidence to the Jira subtask.
Story 4 — Society, Block & Flat Management
Objective: Allow authorized administrators to manage society configuration, blocks, and flats while protecting tenant/society boundaries and billing-critical flat attributes.
Dependencies: Auth/RBAC; initial society; future resident links and billing.
Runtime behavior is specified in the Scenario Catalogue at the end of this story. The API, database state machine, UI, and tests must implement the same outcomes.
1. Backend — Node.js + Express
Endpoints: GET/PUT /api/v1/society; GET/POST /api/v1/blocks; PATCH /api/v1/blocks/{blockId}; GET/POST /api/v1/blocks/{blockId}/flats; GET/PATCH /api/v1/flats/{flatId}.
Authenticate the user.
Require the SOCIETY_MANAGE permission.
Derive societyId from the authenticated server context.
Validate the request payload.
Verify that the parent block or society exists and is valid.
Enforce unique block codes and flat numbers.
Require sqft > 0.
Ensure floor_no is an integer when provided.
Perform the database write within a transaction.
Record an audit log containing the before and after values.
Return the response DTO.
The initial society is created before public app access by `npm run bootstrap:society`. The command requires society name, address, city, state, postal code, timezone, first General Admin name and phone. It creates the society, society_settings, General Admin user, ADMIN role/profile and first gate in one transaction; the generated temporary password is 12+ characters, hashed in PostgreSQL, and displayed once to the operator. Public signup is disabled. Public signup is disabled. The Admin UI edits the bootstrapped society and manages its blocks/flats.
Block code is unique within society; flat number is unique within block. Deactivation is the only normal removal operation once a block/flat has residents, visits, assignments, invoices or history. The record is marked INACTIVE and remains queryable for historical reports; a hard delete is rejected whenever dependent records exist.
Resolve the parent block using both blockId and the authenticated societyId. If no block row exists in that society, return 404 BLOCK_NOT_FOUND. If the block exists in the same society but is INACTIVE, return 409 BLOCK_INACTIVE. Do not insert or update the flat in either case. Never trust a submitted societyId to move a flat across societies. Changes to sqft affect future billing calculations only; existing issued invoices are immutable and must not be recalculated.
Low-level Design


Controllers: SocietyController, BlockController, and FlatController.
Services: SocietyService and BlockFlatService.
Repositories: Handle database operations.
Store sqft as NUMERIC in the database instead of using floating-point types.
Validate all update differences before persisting changes.

2. Database — PostgreSQL (DDL/DML)
CREATE TABLE IF NOT EXISTS blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id UUID NOT NULL REFERENCES societies(id),
  code VARCHAR(50) NOT NULL,
  name VARCHAR(120) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (society_id, code)
);
CREATE TABLE IF NOT EXISTS flats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id UUID NOT NULL REFERENCES blocks(id),
  flat_no VARCHAR(40) NOT NULL,
  floor_no INTEGER,
  sqft NUMERIC(10,2) NOT NULL CHECK (sqft > 0),
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (block_id, flat_no)
);

 
DML examples: GET flats by block uses parameterized `WHERE block_id=$1 AND status='ACTIVE' ORDER BY floor_no, flat_no`; before writing flat, verify block is active and belongs to the caller society. Use `RETURNING` to build response DTO.
Transaction: create/update + audit record together. DB uniqueness constraints remain the final protection against simultaneous duplicate block/flat creation.
3. Frontend — React/Vite/Tailwind/react-i18next
Figma screens: Society Settings; Blocks list; Create/Edit Block modal/page; Flats list grouped by block; Create/Edit Flat form; validation errors; loading; empty; duplicate block/flat; inactive parent; permission denied; confirmation before deactivate.
Forms: required name/code, flat number, positive sqft; numeric decimal input for sqft; explicit unit label (sq ft); no free-form society assignment in normal user forms.
API flow: load list > create/update > show field-level errors > refresh/invalidate list > navigate to details. Prevent double submission while pending.
For small screen, use stacked cards instead of wide tables. For desktop, provide server-side search, sort by name/code/status, default page size 25 and maximum page size 100; mobile renders the same result set as stacked cards. Never show edit buttons unless SOCIETY_MANAGE, while still handle API 403.
4. Notifications — Socket.IO / Web Push / Email
No routine notification required for creating a block/flat. Audit changes to important society settings and structural edits.
If society setting changes affect multiple screens, refetch/clear client cache on success; do not require realtime events unless multiple concurrent administrators need live updates.
Acceptance / review checklist
Only authorized admin-permission holder can create/update.
Block code uniqueness and flat number uniqueness are enforced by DB.
Flat belongs to valid block in caller society.
sqft > 0. Issued invoices are immutable; a correction is represented as a separate audited ONE_TIME/ADJUSTMENT invoice and never overwrites a prior invoice line.
Historical dependent data is not deleted by a normal deactivate action.
 
Runtime Scenario Catalogue — Story 4 — Society, Block & Flat Management
Use these exact cases for implementation review and QA. Each row defines the trigger, backend/database outcome, HTTP/UI result and required side effect. A case passes only when the observable response and persisted state match.
Scenario / trigger
Backend and database behavior
Expected response, UI and side effects
SOC-01 | Create society
General Admin submits name, address, timezone and settings. Validate required fields; create society and default notification/billing settings transactionally.
Return 201 with society ID. Audit SOCIETY_CREATED; Admin dashboard displays the society record.
SOC-02 | Create duplicate block code
Normalize block code and check unique (society_id, code); database unique constraint is authoritative.
Return 409 BLOCK_CODE_EXISTS. Form retains entered values and focuses block code.
SOC-03 | Create valid flat
Require active block in same society, flat number, floor and sqft > 0; insert flat with unique (block_id, flat_number).
Return 201. Flat appears under the selected block and is eligible for resident linking/billing.
SOC-04 | Missing or non-positive sqft
Validate sqft before repository call and enforce CHECK (sqft > 0) in PostgreSQL.
Return 400 VALIDATION_FAILED. No flat row is created; billing cannot encounter a silently zero-sized flat.
SOC-05 | Flat references another society’s block
Resolve block by both blockId and authenticated societyId before insert/update.
Return 404 BLOCK_NOT_FOUND. No cross-society relationship is created.
SOC-06 | Duplicate flat number in block
Query and rely on UNIQUE(block_id, flat_number).
Return 409 FLAT_NUMBER_EXISTS; existing flat remains unchanged.
SOC-07 | Edit block/flat
Validate permission, same-society scope, allowed fields and uniqueness; write audit before/after values in same transaction.
Return 200 with updated data. Updated labels/size appear after API cache invalidation; historical bills retain stored calculation inputs.
SOC-08 | Deactivate block/flat with history
Reject hard deletion when residents, visits, invoices or assignments exist. Set status=INACTIVE and preserve foreign-key history.
Return 200 for deactivation. Inactive flat cannot receive a new resident link, visit destination or invoice; historic views remain available to authorized users.
SOC-09 | Guard/Resident tries management API
Require exact Admin management permission on every endpoint.
Return 403 with no DB mutation, regardless of whether the UI route was hidden.

Tech Lead exit check: demonstrate one positive case, one authorization failure, one state/validation failure, and one retry/concurrency case from this catalogue. Attach sanitized request/response and database-state evidence to the Jira subtask.
Story 5 — Resident & Tenant Management
Objective: Link app users to flats with owner/tenant relationship data and date-bounded access, preserving historic occupancy and enforcing approved resident permissions.
Dependencies: Society/block/flat; users/auth/RBAC; flat_residents relationship table.
Runtime behavior is specified in the Scenario Catalogue at the end of this story. The API, database state machine, UI, and tests must implement the same outcomes.
1. Backend — Node.js + Express
Endpoints: GET /api/v1/residents; POST /api/v1/residents (if user creation is in scope); GET /api/v1/flats/{flatId}/residents; POST /api/v1/flats/{flatId}/residents; PATCH /api/v1/flat-residents/{linkId} for move-out/access changes.
Create/link logic: require USER_MANAGE > verify active user and flat in same society > enforce one active OWNER and at most one active TENANT > when adding Tenant set Owner access_level=VIEW_ONLY > for every still-pending visit approval on that flat, mark the current approval request SUPERSEDED and create a new PENDING request for the tenant, preserving the original reminder_at/escalate_at > write link, audit and notification outbox in one transaction. On tenant move-out, close the tenant link, restore Owner access_level=FULL and reassign any still-pending approval to the owner while preserving the existing deadlines. If no FULL-access approver remains, move the visit to AWAITING_MANUAL immediately.
Move-out logic: validate Admin permission and same-society scope > lock the active TENANT relationship > set end_date to the move-out date > preserve the historic relationship and all visits/payments > remove the tenant’s effective flat-scoped access immediately > restore owner FULL resident access > for every AWAITING_APPROVAL visit on that flat, mark the tenant request SUPERSEDED and create a PENDING owner request using the existing reminder_at/escalate_at > write audit/outbox in the same transaction. The scheduler processes an already-expired escalation deadline immediately.
Flat-scope access uses flat_residents effective dates. With an active tenant, the tenant has FULL resident access. The owner retains read-only visit/bill/payment status access and cannot approve, create passes, pay bills, or perform other resident mutations. When the tenant link ends, owner FULL access is restored automatically. A flat supports one active OWNER and at most one active TENANT link.
Low-level design: ResidentLinkService owns link lifecycle and date rules. Authentication identity remains in users; relationship metadata stays in flat_residents, not duplicated role rows.
2. Database — PostgreSQL (DDL/DML)
CREATE TABLE IF NOT EXISTS flat_residents (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   flat_id UUID NOT NULL REFERENCES flats(id),
   user_id UUID NOT NULL REFERENCES users(id),
   relationship_type VARCHAR(10) NOT NULL
     CHECK (relationship_type IN ('OWNER','TENANT')),
   access_level VARCHAR(16) NOT NULL DEFAULT 'FULL' CHECK (access_level IN ('FULL','VIEW_ONLY')),
   start_date DATE NOT NULL,
   end_date DATE,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   CHECK (end_date IS NULL OR end_date >= start_date),
   UNIQUE (flat_id, user_id, start_date)
 );
 CREATE INDEX IF NOT EXISTS idx_flat_residents_user
   ON flat_residents(user_id, flat_id);
 CREATE UNIQUE INDEX IF NOT EXISTS uq_active_owner_per_flat
   ON flat_residents(flat_id) WHERE relationship_type='OWNER' AND end_date IS NULL;
 CREATE UNIQUE INDEX IF NOT EXISTS uq_active_tenant_per_flat
   ON flat_residents(flat_id) WHERE relationship_type='TENANT' AND end_date IS NULL;
 -- MVP relationship rule: start_date must be today or earlier; end_date stays NULL while active and is set on move-out. Future-dated tenancy is not created.

 
A flat has one active OWNER relationship and at most one active TENANT relationship. Enforce these rules with partial unique indexes on flat_residents WHERE end_date IS NULL. A tenant move-out must set end_date before another tenant link is created.
SELECT fr.id, fr.relationship_type, fr.access_level, fr.start_date, fr.end_date
 FROM flat_residents fr
 WHERE fr.user_id = $1 AND fr.flat_id = $2
   AND fr.start_date <= CURRENT_DATE
   AND fr.end_date IS NULL;

 
Validate the current relationship.
Close the previous active relationship if the resident is moving out.
Create the new relationship.
Update the owner's access_level to FULL or VIEW_ONLY based on tenant occupancy.
Revoke or refresh affected sessions and permission states.
Record an audit log of the before-and-after states.
Commit the transaction.
Rollback: If any constraint fails, roll back the entire relationship change to maintain data consistency.

3. Frontend — React/Vite/Tailwind/react-i18next
Figma screens: Resident directory; resident details; Assign Resident to Flat; relationship type Owner/Tenant; access status; tenant move-out date; existing occupants; duplicate/overlap errors; resident history; mobile form; empty/loading/error states.
Admin selects block/flat from server-loaded options. Form validates user and dates; warns before ending a relationship. Display relationship history without exposing another society’s records.
Resident-side screens only display the flats to which the logged-in user has active access. When multiple flats are linked, show a clear flat selector. Every request uses the selected flat ID but backend revalidates its relationship.
Use clear language for relationship type versus application role; do not display Owner/Tenant as separate login roles unless product specifically asks for a role picker for UX only.
4. Notifications — Socket.IO / Web Push / Email
On tenant activation and move-out, write an in-app audit/notification event for the affected owner and tenant accounts. Do not include a full address or identity number in push/email payloads.
Access/relationship changes may invalidate cached resident permissions and subscribed socket rooms. Recalculate authorization server-side for subsequent requests.
Acceptance / review checklist
Relationship data is not confused with application role.
Flat and user must be in the same society.
Historical occupancy links remain available after move-out.
Owner/tenant access matches the approved matrix.
Cross-flat access without an active relationship is rejected.
 
Runtime Scenario Catalogue — Story 5 — Resident & Tenant Management
Use these exact cases for implementation review and QA. Each row defines the trigger, backend/database outcome, HTTP/UI result and required side effect. A case passes only when the observable response and persisted state match.
Scenario / trigger
Backend and database behavior
Expected response, UI and side effects
RES-01 | Link an Owner to a flat
Admin validates user is active, flat is active and same-society, and no other active OWNER link exists. Insert flat_residents relationship with relationship_type=OWNER and start_date.
Return 201. Write audit and resident-link notification. Existing user account is reused; do not duplicate users table rows.
RES-02 | Add active Tenant
Validate same-society user/flat, tenant start_date <= CURRENT_DATE, end_date IS NULL and unique active tenant per flat. Insert TENANT relationship, set owner access_level=VIEW_ONLY and reassign any pending approval to tenant while preserving original deadlines; write audit/outbox atomically.
Return 201. Tenant receives FULL resident write access. Owner becomes VIEW_ONLY for visit/bill/payment status and receives no approval action.
RES-03 | Second active tenant for one flat
Check and enforce partial unique index on (flat_id) where relationship_type=TENANT and end_date IS NULL.
Return 409 ACTIVE_TENANT_EXISTS. Current tenant link is not overwritten.
RES-04 | Tenant move-out
General Admin validates the active TENANT relationship and sets end_date to the move-out date. flat_residents has no status column. In the same transaction, re-evaluate owner access, reassign pending approvals, write audit and outbox, and preserve all history.
Return 200. Tenant loses flat access immediately because the relationship is no longer active; Owner access_level becomes FULL. Tenant session remains valid for other authorized society/flat relationships but cannot call endpoints for the moved-out flat.
RES-05 | Same phone submitted as a new user
Normalize phone and query globally unique users.phone_normalized. If it already exists, do not insert a second user row and do not create a relationship automatically. Return 409 PHONE_ALREADY_REGISTERED; Admin then searches/selects that existing user and submits the separate authorized flat-link operation.
UI shows “User already exists” and opens the existing-user selection/link flow. No new users row or flat_residents row is written by the failed create-user request. Link succeeds only after a separate request validates society, flat, relationship type and uniqueness.
RES-06 | Invalid resident/flat scope
Validate the target flat belongs to caller’s society, is active, and relationship type is allowed.
Return 404 for foreign-society IDs or 400 for invalid relationship dates; no partial user/link data remains.
RES-07 | Relationship date overlap
If start_date is after end_date, reject with 400 INVALID_RELATIONSHIP_DATES. If an active duplicate Owner/Tenant relationship exists, reject with 409 ACTIVE_RELATIONSHIP_EXISTS. A replacement link is created only after the previous relationship is closed in the same transaction.
Return the matching 400 or 409 error; no partial user/link write occurs. Existing relationship history remains intact.
RES-08 | Deactivate resident login
Admin marks user inactive and revokes active sessions; keep flat link dates and historical rows.
Resident cannot log in or call APIs; past visits, invoices, payments and audit records remain queryable to authorized Admin.
RES-09 | Owner/tenant bill permissions
Apply flat relationship state and permission code at each GET/POST billing endpoint.
Tenant with active link can view/pay. Owner with active tenant can view bill/payment status only and receives 403 when attempting checkout; after tenant move-out owner write permissions return.

Tech Lead exit check: demonstrate one positive case, one authorization failure, one state/validation failure, and one retry/concurrency case from this catalogue. Attach sanitized request/response and database-state evidence to the Jira subtask.
Story 6 — Guard & Staff Management
Objective: Manage guard accounts and recurring service-staff records, assignments, verification status and active/block state. Guard accounts are application users with role GUARD and a guard_profiles row. Daily-help staff are records/passes only and never receive application login accounts in this MVP.
Dependencies: Auth/RBAC; society/flat setup; residents; passes; staff movement.
Runtime behavior is specified in the Scenario Catalogue at the end of this story. The API, database state machine, UI, and tests must implement the same outcomes.
1. Backend — Node.js + Express
Endpoints: GET/POST/PATCH /api/v1/guards (General Admin only); GET/POST/PATCH /api/v1/staff; POST /api/v1/staff/{staffId}/assignments; PATCH /api/v1/staff/{staffId}/assignments/{assignmentId}; POST /api/v1/staff/{staffId}/passes; POST /api/v1/staff/{staffId}/passes/{passId}/revoke. General Admin uses STAFF_MANAGE. Resident create/link requests use STAFF_MANAGE_OWN and must target an active own flat with FULL access; the service derives the flat from authorized context and rejects a mismatched flatId. Guard uses STAFF_VALIDATE/STAFF_MOVEMENT only.
Guard accounts use `users` + GUARD role and may carry gate assignment. Daily-help staff (maid/driver/cook/etc.) are records/passes, not authenticated users. Only General Admin can manage guard/staff profiles; a Resident can manage daily-help links only for an active own flat through STAFF_MANAGE_OWN. Guard can only validate staff and record movement.
Create staff: validate name, Indian mobile number, category and required profile photograph (JPEG/PNG/WebP, max 5 MB); validate ID type/number when society_settings.id_required=true; encrypt captured ID with AES-256-GCM using DATA_ENCRYPTION_KEY; create PENDING staff profile and date-bounded flat assignments in one transaction. Generate an active staff pass only after verification_status=VERIFIED. Audit operation and never log full government ID.
Block/deactivate staff: lock staff record, mark pass revoked/inactive, stop any subsequent pass validation or entry; preserve historic movements. Re-activate only after authorized status change and any required re-verification.
Low-level design: StaffService, StaffAssignmentService, StaffPassService. The pass cache is refreshed on every successful sync and every 15 minutes while online; a cached pass never overrides a newer server-side block/revocation during sync.

























2. Database — PostgreSQL (DDL/DML)
CREATE TABLE IF NOT EXISTS staff (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   society_id UUID NOT NULL REFERENCES societies(id),
   full_name VARCHAR(160) NOT NULL,
   phone_normalized VARCHAR(20) NOT NULL,
   category VARCHAR(50) NOT NULL,
   verification_status VARCHAR(24) NOT NULL DEFAULT 'PENDING'
     CHECK (verification_status IN ('PENDING','VERIFIED','REJECTED','REVERIFY')),
   is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
   photo_path TEXT NOT NULL,
   id_type VARCHAR(40),
   id_number_encrypted TEXT,
   id_number_lookup_hash TEXT,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   UNIQUE (society_id, phone_normalized)
 );
 CREATE TABLE IF NOT EXISTS staff_flat_assignments (
   staff_id UUID NOT NULL REFERENCES staff(id),
   flat_id UUID NOT NULL REFERENCES flats(id),
   start_date DATE NOT NULL,
   end_date DATE,
   PRIMARY KEY (staff_id, flat_id, start_date),
   CHECK (end_date IS NULL OR end_date >= start_date)
 );
 CREATE INDEX IF NOT EXISTS idx_staff_active_assignment
   ON staff_flat_assignments(flat_id, staff_id, start_date, end_date);
 CREATE TABLE IF NOT EXISTS staff_passes (
   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
   society_id UUID NOT NULL REFERENCES societies(id),
   staff_id UUID NOT NULL REFERENCES staff(id),
   code_hash TEXT NOT NULL,
   valid_from TIMESTAMPTZ NOT NULL,
   valid_to TIMESTAMPTZ NOT NULL,
   status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
     CHECK (status IN ('ACTIVE','REVOKED','EXPIRED')),
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   UNIQUE (society_id, code_hash),
   CHECK (valid_to > valid_from),
   CHECK (valid_to <= valid_from + INTERVAL '365 days')
 );

 -- guard_profiles, gates and guard_gate_assignments are created in Migration 001_base_schema.sql.

 -- A staff ID is stored as base64(nonce || AES-256-GCM tag || ciphertext); lookup uses HMAC-SHA256 with a separate key.
 -- The raw ID is never returned in ordinary APIs and only the last four characters are displayed.
 -- Staff photo paths are private local-storage keys and are served only through an authenticated endpoint.




 
Government ID encryption is mandatory when an ID is captured: store AES-256-GCM ciphertext in id_number_encrypted using a 32-byte DATA_ENCRYPTION_KEY from the server environment; store a separate keyed HMAC-SHA256 lookup digest for exact ID search. App startup fails when DATA_ENCRYPTION_KEY is absent or invalid. APIs and logs show only the masked last four digits; never return the decrypted value in normal list/detail DTOs.
Pass-validation DML must verify staff active, not blocked, required verification status, pass status/expiry, and valid assignment before returning valid.
3. Frontend — React/Vite/Tailwind/react-i18next
Figma screens: Guards list; Create/Edit Guard; Staff list/search; Staff profile; verification states Pending/Verified/Rejected/Re-verification Required; Assign Flat; Generate/View Pass; Block/Unblock confirmation; empty/loading/network/error states.
Admin can filter by name/phone/category/verification status. Staff ID fields are always masked in ordinary views. A staff profile requires a photograph; upload accepts JPEG/PNG/WebP up to 5 MiB, strips EXIF, shows validation/progress/success/error, stores a UUID-named file outside the public webroot, and serves it only through authorized endpoints.
When block action succeeds, immediately update the visible pass status and invalidate any cached pass list. Make destructive/block actions explicit and auditable.
Guard UI should provide only operational verification/entry tasks, not staff profile administration unless a separate permission explicitly permits it.
4. Notifications — Socket.IO / Web Push / Email
Notify all active flats associated with the staff member after entry/exit commits. Re-verification due is shown as a status in Admin staff management; the MVP does not run a separate reminder schedule for verification expiry.
Blocking/deactivation must invalidate relevant caches and passes; do not rely on a push event to enforce access control.
Acceptance / review checklist
Inactive/blocked staff pass can no longer authorize entry.
Assignment history is date-bounded and preserved.
Staff record is separate from application user unless new login role is approved.
ID/photo storage is protected and access is scoped.
Guard accounts are not accidentally given Admin or Resident permissions.
 
Runtime Scenario Catalogue — Story 6 — Guard & Staff Management
Use these exact cases for implementation review and QA. Each row defines the trigger, backend/database outcome, HTTP/UI result and required side effect. A case passes only when the observable response and persisted state match.
Scenario / trigger
Backend and database behavior
Expected response, UI and side effects
GST-01 | Create Guard and assign gate
Admin creates user with GUARD role, active guard profile and one or more active guard_gate_assignments.
Return 201. Guard login routes to Guard dashboard; API requests must supply a gate assigned to that guard.
GST-02 | Guard uses unassigned gate
Resolve gate assignment by userId, gateId and effective dates before any gate operation.
Return 403 GATE_ACCESS_DENIED. No visitor/staff event is written.
GST-03 | Create daily-help staff profile
Require name, phone, category and photo; require ID fields only when society setting says so; encrypt captured ID number. Create PENDING profile and flat assignments.
Return 201 PENDING. No valid entry pass is issued until Admin marks staff VERIFIED.
GST-04 | Verify staff
Admin reviews profile and sets verification_status=VERIFIED or REJECTED with actor/time/reason.
Verified staff can receive an active time-bound pass. Rejected staff cannot obtain an entry-valid pass; resident/guard view shows reason code without exposing full ID.
GST-05 | Block/deactivate staff
Set is_blocked=true and revoke all active passes in one transaction; audit before/after.
Subsequent pass validation immediately returns STAFF_BLOCKED; guard cannot record entry even if an old QR/code is presented.
GST-06 | Staff assigned to multiple flats
Create date-bounded staff_flat_assignments; validate each flat is active and in the same society.
Return the current assignment list. Entry notification targets only active associated flats.
GST-07 | Duplicate staff phone or overlapping link
Detect existing same-society staff by normalized phone and prevent duplicate active profile/overlapping duplicate flat assignment.
Return 409 STAFF_ALREADY_EXISTS or ASSIGNMENT_EXISTS; history is not replaced.
GST-08 | Photo/ID upload failure
Validate file type/size and use local file storage in zero-cost local deployment; DB commit occurs only after file save succeeds.
Return 400 INVALID_FILE or 503 STORAGE_ERROR. Do not create a profile that points to a missing photo.
GST-09 | Guard attempts staff administration
Require STAFF_MANAGE for profile updates and Admin scope; guard only receives pass-validation/movement permissions.
Return 403; no staff status or assignment changes.

Tech Lead exit check: demonstrate one positive case, one authorization failure, one state/validation failure, and one retry/concurrency case from this catalogue. Attach sanitized request/response and database-state evidence to the Jira subtask.
