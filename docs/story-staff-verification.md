1.Objective
Provide a lightweight and auditable mechanism for authorized security users to verify staff/service personnel and record their actual movement through the society gate.

This subtask is specifically for staff movement and verification.

It does not manage staff profiles, create staff accounts, manage Guard accounts, or manage normal visitor approval.

User Story
As an authorized Guard,
I want to verify staff/service personnel and record their entry and exit,
so that the society has an accurate record of staff movement.

As an authorized Admin,
I want to view staff movement records,
so that I can monitor and audit staff access.

2. Scope
In Scope
Staff verification at gate

Staff identity/profile lookup

Active/inactive validation

Society assignment validation

Gate/duty assignment validation where configured

Staff entry recording

Staff exit recording

Current staff-inside view

Staff movement history

Verification result

Rejection reason

Duplicate movement prevention

Server timestamps

Audit trail

Role/society authorization

Out of Scope
Function

Owner

Staff profile creation

SMB-7

Staff account creation

SMB-7

Guard account management

SMB-7

Staff approval/onboarding

SMB-7/Admin process

Normal visitor registration

SMB-46

Visitor approval

SMB-50

Visitor entry/exit

SMB-51 / SMB-63 / SMB-64

Visitor movement history

SMB-65

Notifications

SMB-52

Payroll

Out of scope

Attendance/payroll calculation

Out of scope

Biometric authentication

Out of scope

GPS tracking

Out of scope

3. Staff Types
The staff profile maintained by SMB-7 may contain a staff type/designation such as:

Domestic Help

Housekeeping

Security Staff

Maintenance

Electrician

Plumber

Driver

Gardener

Technician

Service Provider

Other authorized staff category

The exact list should remain configurable.

SMB-75 consumes the staff profile; it does not create or maintain it.

4. Verification Rules
Before staff entry is recorded, the backend must verify:

Staff record exists.

Staff belongs to the current society.

Staff is Active.

Staff account/identity is valid where required.

Guard is authorized for the current society/gate.

Staff is not already marked as inside.

Any required assignment/duty restriction is satisfied.

Required verification information is available.

Entry request has not already been successfully processed.

If any mandatory condition fails:



Entry is rejected.
No successful ENTRY event is created.
5. Verification
The initial implementation should remain lightweight.

Possible verification methods:

Staff ID/reference

Registered mobile number

QR/staff pass where configured

Staff name/photo comparison by Guard

Assigned society/gate validation

The system should not require biometric verification unless explicitly added as a future requirement.

Important
A QR code or staff ID is an identifier, not automatic authorization.

The backend must validate the staff record and current status.

6. Entry Flow


flowchart TD
    A[Guard selects/scans staff] --> B[Backend Lookup]
    B --> C{Staff Exists?}
    C -->|No| D[Reject Verification]
    C -->|Yes| E{Active?}
    E -->|No| D
    E -->|Yes| F{Correct Society?}
    F -->|No| D
    F -->|Yes| G{Already Inside?}
    G -->|Yes| H[Return Already Inside]
    G -->|No| I[Guard Verifies Staff]
    I --> J{Verification Successful?}
    J -->|No| D
    J -->|Yes| K[Create ENTRY Event]
    K --> L[Server Timestamp]
    L --> M[Staff Marked Inside]
    M --> N[Optional Notification]
7. Exit Flow
Exit is intentionally simple.



Guard identifies staff
        ↓
Backend verifies staff
        ↓
Staff must currently be INSIDE
        ↓
Record EXIT
        ↓
Server timestamp
        ↓
Staff becomes NOT INSIDE
If the staff member is not currently inside:



No EXIT event should be created.
8. Staff Movement State
Recommended movement states:



NOT_INSIDE
INSIDE
EXITED
ENTRY_REJECTED
The profile's Active/Inactive status is separate from movement state.

For example:



Staff = Active
Movement = Not Inside
does not mean the staff member is currently present.

9. Staff Entry vs Staff Profile
This distinction is important.

SMB-7
Owns:



Who is this staff member?
Is the staff member active?
Which society are they assigned to?
Which account is linked?
SMB-75
Owns:



Did this staff member enter?
Did this staff member exit?
Was the staff member verified?
Was entry rejected?
When did the movement happen?
10. Backend Logic
10.1 Entry
Conceptual service:



recordStaffEntry(staffId, guardId, gateId, idempotencyKey)
Backend:

Authenticate Guard.

Validate Guard role.

Validate Guard is active.

Validate society assignment.

Validate gate assignment if configured.

Load staff record.

Validate staff belongs to same society.

Validate staff Active status.

Check current movement state.

Prevent duplicate active entry.

Record ENTRY event atomically.

Set server timestamp.

Return movement result.

Optionally publish notification event to SMB-52.

11. Exit
Conceptual service:



recordStaffExit(staffId, guardId, gateId, idempotencyKey)
Backend:

Authenticate Guard.

Validate Guard authorization.

Load staff.

Verify same society.

Verify staff is currently inside.

Prevent duplicate exit.

Create EXIT event.

Use server timestamp.

Update current movement state.

Return successful result.

Optionally publish notification event.

12. Idempotency
Repeated taps/scans must not create multiple movements.

Example:



Guard taps Entry
     ↓
Request ID = ABC123
     ↓
ENTRY created
     ↓
Network response lost
     ↓
Guard retries
     ↓
Request ID = ABC123
     ↓
Existing result returned
No duplicate ENTRY event should be generated.

A database uniqueness rule or equivalent transactional mechanism should enforce this.

13. Concurrency
Two Guards may attempt to record the same staff member's entry at nearly the same time.

The backend must guarantee:



At most one active entry
Example:



Guard A → Entry request
Guard B → Entry request
Only one succeeds.
Second request:
"Staff already inside"
This must be enforced server-side rather than relying on UI disabling.

14. DB / DDL Considerations
These are logical/proposed structures and must be reconciled with the actual project schema.

SMB-75 should preferably reuse the staff/profile structures created by SMB-7.

A dedicated movement-event table is recommended.

Proposed staff_movement_events


CREATE TABLE staff_movement_events (
    movement_event_id UUID PRIMARY KEY,
    staff_id UUID NOT NULL,
    society_id UUID NOT NULL,
    event_type VARCHAR(30) NOT NULL,
    verification_status VARCHAR(30) NOT NULL,
    gate_id UUID,
    performed_by UUID NOT NULL,
    event_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rejection_reason VARCHAR(255),
    idempotency_key VARCHAR(150),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
Possible event types:



ENTRY
EXIT
ENTRY_REJECTED
Possible verification statuses:



VERIFIED
REJECTED
15. Recommended Indexes


CREATE INDEX idx_staff_movement_staff
ON staff_movement_events(staff_id, event_timestamp DESC);
CREATE INDEX idx_staff_movement_society
ON staff_movement_events(society_id, event_timestamp DESC);
CREATE INDEX idx_staff_movement_timestamp
ON staff_movement_events(event_timestamp DESC);
If the database design requires a direct "currently inside" representation, it can be derived from the latest valid movement state or maintained through a controlled transactional state.

Avoid maintaining multiple independent sources of truth without a clear consistency strategy.

16. Movement State Derivation
Preferred lightweight approach:



Latest successful ENTRY
        +
No subsequent successful EXIT
        =
Currently INSIDE
An explicit current-state field may be used if required for performance, but it must be updated transactionally with movement events.

17. API Design
Verify Staff


GET /api/v1/staff/:staffId/verification
Response should provide only the information necessary for gate verification.

Example:



{
  "staffId": "STF-123",
  "name": "Example Staff",
  "staffType": "HOUSEKEEPING",
  "active": true,
  "currentlyInside": false
}
Record Entry


POST /api/v1/staff/:staffId/movement/entry
Example:



{
  "gateId": "GATE-01",
  "idempotencyKey": "ABC123"
}
Record Exit


POST /api/v1/staff/:staffId/movement/exit
Example:



{
  "gateId": "GATE-01",
  "idempotencyKey": "XYZ456"
}
Reject Entry


POST /api/v1/staff/:staffId/movement/entry-rejection
Example:



{
  "gateId": "GATE-01",
  "reason": "STAFF_INACTIVE"
}
Current Staff Inside


GET /api/v1/gate/staff-inside
Staff Movement History


GET /api/v1/staff/:staffId/movement-history
Admin-level history may support:



GET /api/v1/staff-movement-history
with filters such as:



staffId
staffType
dateFrom
dateTo
gateId
eventType
verificationStatus
18. UI — Guard
Staff Search
Guard can:

Search by staff ID

Search by registered mobile where permitted

Scan staff QR/pass where configured

Display:



Staff Name
Staff Type
Photo (if available)
Active / Inactive
Current Movement
19. Staff Verification Screen
Example:



--------------------------------
Staff Verification
Name:       Ahmed Khan
Type:       Housekeeping
Status:     Active
Movement:   Not Inside
[ Verify & Record Entry ]
[ Reject ]
--------------------------------
The Guard must confirm physical verification before recording successful entry.

20. UI States
Loading


Verifying staff...
Valid


Staff verified
Inactive


Staff access is inactive.
Entry cannot be recorded.
Wrong Society


Staff is not assigned to this society.
Already Inside


Staff is already marked as inside.
Verification Failed


Verification failed.
Entry was not recorded.
Network Failure


Unable to verify staff.
Please check connection and try again.
Do not display "Entry successful" unless the server confirms it.

21. Rejection Reasons
Where staff entry is rejected, a reason should be recorded.

Recommended values:

Staff inactive

Staff not registered

Wrong society

Verification failed

Invalid staff pass

Already inside

Security concern

Other

For Other, a short description should be required.

The exact reason list can be configured by product policy.

22. Staff Inside Screen
Guard/Admin can see currently active staff movement.

Example:



Staff Currently Inside
Ahmed Khan
Housekeeping
Entry: 08:42
Gate: Gate 1
Priya Sharma
Maintenance
Entry: 09:15
Gate: Gate 1
This is a movement view, not a payroll/attendance calculation.

23. Movement History
History should include:

Staff

Staff type

Event type

Verification status

Gate

Performed by

Server timestamp

Rejection reason if applicable

Filters:

date range

staff

staff type

gate

entry/exit

verification status

Pagination should be used for large datasets.

24. Sequence Diagram


sequenceDiagram
    participant G as Guard
    participant API as Backend API
    participant AUTH as Authorization
    participant DB as PostgreSQL
    participant N as SMB-52
    G->>API: Verify Staff
    API->>AUTH: Validate Guard + Society
    AUTH-->>API: Authorized
    API->>DB: Load Staff
    DB-->>API: Staff Profile + Status
    API->>DB: Check Current Movement
    DB-->>API: NOT_INSIDE
    G->>API: Record Entry
    API->>DB: Atomic ENTRY transaction
    DB-->>API: ENTRY created
    API->>N: Publish Staff Entry Event
    API-->>G: Entry Successful
25. Staff Movement State Diagram


stateDiagram-v2
    [*] --> NOT_INSIDE
    NOT_INSIDE --> INSIDE: Verified Entry
    NOT_INSIDE --> ENTRY_REJECTED: Verification Failed
    ENTRY_REJECTED --> NOT_INSIDE
    INSIDE --> NOT_INSIDE: Verified Exit
    INSIDE --> INSIDE: Duplicate Entry Attempt
26. Logical Data Relationship


erDiagram
    SOCIETY ||--o{ STAFF : contains
    STAFF ||--o{ STAFF_MOVEMENT_EVENTS : has
    USER ||--o{ STAFF_MOVEMENT_EVENTS : performs
    GATE ||--o{ STAFF_MOVEMENT_EVENTS : occurs_at
    SOCIETY {
        uuid society_id PK
    }
    STAFF {
        uuid staff_id PK
        uuid society_id FK
        string name
        string staff_type
        boolean active
    }
    USER {
        uuid user_id PK
    }
    GATE {
        uuid gate_id PK
        uuid society_id FK
    }
    STAFF_MOVEMENT_EVENTS {
        uuid movement_event_id PK
        uuid staff_id FK
        uuid society_id FK
        string event_type
        string verification_status
        uuid gate_id FK
        uuid performed_by FK
        timestamp event_timestamp
        string rejection_reason
    }
27. Security
Guard Authorization
Backend must verify:



Authenticated
        +
GUARD role
        +
Active account
        +
Correct society
        +
Authorized gate
Admin
Admin can view movement history according to society scope.

Resident
Residents should not have unrestricted access to staff movement history.

Any resident-facing staff information should be explicitly defined by product policy.

28. Historical Integrity
If a staff member is later deactivated:



Staff Profile = INACTIVE
Existing movement history must remain available.

Deactivation must not delete:

previous entry

previous exit

rejection events

verification records

audit history

29. Corrections
If a Guard records an incorrect movement:

Do not silently update/delete the original event.

Instead:



Original event
      ↓
Correction request
      ↓
Authorized correction
      ↓
Audit record
The original event should remain traceable.

If correction functionality is not required for the initial release, it can be handled through an authorized administrative process.

30. Offline Policy
Initial implementation should be online-only.

Reason:

Staff status and current movement must be validated against current server state.

If network connectivity is unavailable:



Do not show successful verification.
Do not create an unconfirmed movement.
Allow safe retry.
Offline staff movement can be considered later with an explicit conflict-resolution and security design.

31. Notification Integration
SMB-75 may publish an event to SMB-52 after a successful staff movement.

Example:



SMB-75
Staff Entry Successful
        ↓
Event
        ↓
SMB-52
        ↓
Configured Admin/Security notification
SMB-75 does not implement Socket.IO/Web Push itself.

Likewise, SMB-52 does not decide whether staff entry is valid.

32. Dependencies
Depends On
SMB-1 — Authentication

SMB-2/3 — User and authorization

SMB-7 — Guard/Staff Management

Gate configuration/access

Existing society structure

Related
SMB-52 — Real-Time Notifications

Does Not Depend On
SMB-46 visitor registration

SMB-50 visitor approval

SMB-51 visitor movement

Staff movement is a separate business flow.

33. Acceptance Criteria
AC1 — Staff Lookup
Given an authorized Guard,
when a valid staff ID is provided,
then the system returns the staff verification information allowed for gate use.

AC2 — Active Staff
Given an active staff member belonging to the society,
when verification succeeds,
then entry can be recorded.

AC3 — Inactive Staff
Given an inactive staff member,
when entry is attempted,
then entry is rejected and no successful ENTRY event is created.

AC4 — Society Isolation
Given staff belonging to another society,
when verification is attempted,
then the system rejects the operation.

AC5 — Entry
Given an active verified staff member who is not currently inside,
when the Guard confirms entry,
then exactly one ENTRY event is recorded with a server timestamp.

AC6 — Duplicate Entry
Given a staff member already inside,
when another entry is attempted,
then no duplicate active ENTRY is created.

AC7 — Exit
Given a staff member currently inside,
when the Guard records exit,
then one EXIT event is recorded.

AC8 — Invalid Exit
Given a staff member who is not inside,
when exit is attempted,
then the system rejects the operation.

AC9 — Verification Rejection
Given verification fails,
then the entry is rejected and the rejection reason is recorded.

AC10 — Idempotency
Given the same movement request is retried,
then only one movement event is created.

AC11 — Concurrent Entry
Given two Guards attempt entry simultaneously,
then the backend allows at most one active entry.

AC12 — Server Timestamp
Given a successful movement,
then the authoritative movement timestamp is generated by the server.

AC13 — Historical Data
Given a staff member becomes inactive,
then previous movement history remains available.

AC14 — Authorization
Given an unauthorized user attempts to record staff movement,
then the operation is rejected.

AC15 — Notification Integration
Given a successful configured staff movement,
then the appropriate event can be published to SMB-52 without making notification delivery part of the movement transaction.

34. Test Cases
#

Test Scenario

Expected Result

1

Search valid staff

Staff details returned

2

Search unknown staff

Staff not found

3

Verify active staff

Verification succeeds

4

Verify inactive staff

Verification rejected

5

Verify staff from another society

Rejected

6

Verify invalid staff ID

Rejected

7

Record valid entry

ENTRY created

8

Verify server timestamp

Server timestamp used

9

Duplicate entry

No duplicate event

10

Concurrent entry

Only one succeeds

11

Valid exit

EXIT created

12

Exit when not inside

Rejected

13

Duplicate exit

No duplicate event

14

Invalid Guard

Access denied

15

Inactive Guard

Access denied

16

Wrong gate

Access denied if gate assignment is enforced

17

Entry verification failure

ENTRY not created

18

Rejection reason required

Validation enforced

19

Other rejection reason

Description required

20

Network failure before request

No false success

21

Network response lost after success

Retry does not duplicate event

22

Staff deactivated after previous entry

Historical record retained

23

Movement history retrieval

Correct records returned

24

Movement history filtering

Correct filtered results

25

Unauthorized history access

Rejected

26

Society isolation

No cross-society records

27

Notification event generated

SMB-52 event published

28

Notification delivery failure

Staff movement remains successful

29

Correction/audit scenario

Original movement remains traceable

30

Mobile/Android UI verification

All states usable on small screen
