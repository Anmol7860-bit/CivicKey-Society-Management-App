import { sql } from 'drizzle-orm'
import {
  boolean,
  time,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  unique,
  uniqueIndex,
  text,
  timestamp,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

export const userRole = pgEnum('user_role', ['RESIDENT', 'GUARD', 'ADMIN'])

/**
 * How a Resident relates to a flat, held per assignment: the same person may own one flat and rent
 * another. A co-owner or co-tenant is a second OWNER or TENANT assignment with FULL access.
 */
export const residentType = pgEnum('resident_type', ['OWNER', 'TENANT'])

/** An assignment grants access only once VERIFIED; a verified mobile number never does. */
export const verificationStatus = pgEnum('verification_status', ['PENDING', 'VERIFIED', 'REJECTED'])

export const idDocumentType = pgEnum('id_document_type', ['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENCE', 'VOTER_ID'])

export const gender = pgEnum('gender', ['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'])

/** Lifecycle of society structure records. Nothing is physically deleted. */
export const recordStatus = pgEnum('record_status', ['ACTIVE', 'INACTIVE'])

export const gateUse = pgEnum('gate_use', ['VISITORS_AND_RESIDENTS', 'VISITORS_ONLY', 'RESIDENTS_ONLY', 'SERVICE_AND_DELIVERY'])

/** What a flat is, as the society sells it. Used with the carpet area for maintenance billing. */
export const flatType = pgEnum('flat_type', ['STUDIO', 'ONE_BHK', 'TWO_BHK', 'THREE_BHK', 'FOUR_BHK', 'PENTHOUSE', 'SHOP'])

/** A guard, someone's daily help, or a vendor working for the society */
export const staffKind = pgEnum('staff_kind', ['GUARD', 'DAILY_HELP', 'VENDOR'])

export const staffShift = pgEnum('staff_shift', ['MORNING', 'EVENING', 'NIGHT', 'FULL_DAY'])

export const policeVerification = pgEnum('police_verification', ['NOT_STARTED', 'SUBMITTED', 'VERIFIED', 'REJECTED'])

/** How the monthly maintenance charge is worked out */
export const chargeBasis = pgEnum('charge_basis', ['PER_SQFT', 'PER_FLAT'])

export const invoiceStatus = pgEnum('invoice_status', ['UNPAID', 'PARTIALLY_PAID', 'PAID', 'CANCELLED'])

export const societies = pgTable(
  'societies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 160 }).notNull(),
    address: varchar('address', { length: 500 }),
    /** Co-operative housing society registration number, as printed on the registration certificate */
    registrationNumber: varchar('registration_number', { length: 64 }),
    /** Only societies that charge GST on maintenance have one */
    gstin: varchar('gstin', { length: 15 }),
    pinCode: varchar('pin_code', { length: 6 }),
    city: varchar('city', { length: 80 }),
    state: varchar('state', { length: 80 }),
    officePhone: varchar('office_phone', { length: 15 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('societies_pin_code_format', sql`${table.pinCode} is null or ${table.pinCode} ~ '^[1-9][0-9]{5}$'`),
    // The standard GSTIN shape: state code, PAN, entity number, 'Z', checksum character
    check(
      'societies_gstin_format',
      sql`${table.gstin} is null or ${table.gstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'`,
    ),
  ],
)

/** Where people enter and leave. A guard works a gate, and every entry and exit records one. */
export const gates = pgTable(
  'gates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    societyId: uuid('society_id')
      .notNull()
      .references(() => societies.id),
    name: varchar('name', { length: 64 }).notNull(),
    usedFor: gateUse('used_for').notNull().default('VISITORS_AND_RESIDENTS'),
    status: recordStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('gates_society_id_name_unique').on(table.societyId, sql`lower(${table.name})`),
    check('gates_name_trimmed', sql`${table.name} = btrim(${table.name}) and ${table.name} <> ''`),
  ],
)

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    societyId: uuid('society_id').references(() => societies.id),
    name: varchar('name', { length: 120 }).notNull(),
    /** 10-digit mobile number, digits only */
    phone: varchar('phone', { length: 15 }).unique(),
    /** Stored lowercase */
    email: varchar('email', { length: 254 }).unique(),
    passwordHash: text('password_hash').notNull(),
    /** Profile details the Add user form collects; all optional, so earlier accounts simply have none */
    dateOfBirth: date('date_of_birth'),
    gender: gender('gender'),
    /** A language the society can address this person in */
    preferredLanguage: varchar('preferred_language', { length: 8 }),
    alternatePhone: varchar('alternate_phone', { length: 15 }),
    emergencyContactName: varchar('emergency_contact_name', { length: 120 }),
    emergencyContactRelationship: varchar('emergency_contact_relationship', { length: 60 }),
    emergencyContactPhone: varchar('emergency_contact_phone', { length: 15 }),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('users_login_identifier_present', sql`${table.phone} is not null or ${table.email} is not null`),
    check('users_email_lowercase', sql`${table.email} = lower(${table.email})`),
    // Widened when a locale is added; the UI only offers what i18n can render
    check(
      'users_preferred_language_supported',
      sql`${table.preferredLanguage} is null or ${table.preferredLanguage} in ('en', 'hi', 'mr')`,
    ),
    // Nobody is their own emergency contact
    check(
      'users_emergency_contact_not_self',
      sql`${table.emergencyContactPhone} is null or ${table.emergencyContactPhone} <> ${table.phone}`,
    ),
  ],
)

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: userRole('name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** The user's assigned application role; one per user. */
export const userRoles = pgTable('user_roles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id')
    .notNull()
    .references(() => roles.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Permission master data, inserted by migration (see modules/access/permissions.ts). */
export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 100 }).notNull().unique(),
  description: text('description').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Permissions every user of a role has. ADMIN has none: Admins get theirs from user_permissions. */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
    index('idx_role_permissions_permission_id').on(table.permissionId),
  ],
)

/** Permissions assigned to one user, e.g. a committee member's. Revoked rows are kept for history. */
export const userPermissions = pgTable(
  'user_permissions',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    grantedBy: uuid('granted_by')
      .notNull()
      .references(() => users.id),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.permissionId] })],
)


/** A block or tower. Names are unique within the society, ignoring case. */
export const blocks = pgTable(
  'blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    societyId: uuid('society_id')
      .notNull()
      .references(() => societies.id),
    name: varchar('name', { length: 64 }).notNull(),
    status: recordStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('blocks_society_id_name_unique').on(table.societyId, sql`lower(${table.name})`),
    check('blocks_name_trimmed', sql`${table.name} = btrim(${table.name}) and ${table.name} <> ''`),
  ],
)

/**
 * A floor in a block. The label is free text (B2, Ground, 1st Floor, Terrace) and is never parsed
 * as a number; sort_order sets the listing order. Labels are stored with whitespace trimmed and
 * collapsed, and are unique within the block ignoring case.
 */
export const floors = pgTable(
  'floors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    blockId: uuid('block_id')
      .notNull()
      .references(() => blocks.id),
    floorLabel: varchar('floor_label', { length: 80 }).notNull(),
    sortOrder: integer('sort_order'),
    status: recordStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Target of the flats (floor_id, block_id) foreign key
    unique('floors_id_block_id_unique').on(table.id, table.blockId),
    uniqueIndex('floors_block_id_label_unique').on(table.blockId, sql`lower(${table.floorLabel})`),
    check(
      'floors_label_normalized',
      sql`${table.floorLabel} = btrim(${table.floorLabel}) and ${table.floorLabel} <> '' and ${table.floorLabel} !~ '[[:space:]]{2}'`,
    ),
  ],
)

/**
 * A flat sits on a floor; its society is resolved through floor → block → society. block_id is
 * copied from the floor for the per-block number uniqueness, and the composite foreign key stops it
 * from disagreeing with the floor.
 */
export const flats = pgTable(
  'flats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    blockId: uuid('block_id').notNull(),
    floorId: uuid('floor_id').notNull(),
    number: varchar('number', { length: 16 }).notNull(),
    status: recordStatus('status').notNull().default('ACTIVE'),
    /** What the flat is, and its carpet area in square feet: both feed the maintenance charge */
    flatType: flatType('flat_type'),
    carpetAreaSqft: integer('carpet_area_sqft'),
    /** Slot labels as the society writes them, e.g. "P-12, P-13"; the count is derived below */
    parkingSlots: varchar('parking_slots', { length: 64 }),
    /** Counted from the labels so the parking charge has a number to multiply, never a second field to keep in step */
    parkingSlotCount: integer('parking_slot_count').generatedAlwaysAs(
      sql`case when btrim(coalesce(parking_slots, '')) = '' then 0 else array_length(string_to_array(parking_slots, ','), 1) end`,
    ),
    /** The intercom extension a guard calls to confirm a visitor */
    intercom: varchar('intercom', { length: 20 }),
    /** Co-owners or flatmates are allowed on this flat */
    sharingAllowed: boolean('sharing_allowed').notNull().default(false),
    /** Caps the active resident assignments while sharing is allowed; null means no cap */
    maxOccupants: integer('max_occupants'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'flats_floor_id_block_id_floors_fk',
      columns: [table.floorId, table.blockId],
      foreignColumns: [floors.id, floors.blockId],
    }),
    unique('flats_block_id_number_unique').on(table.blockId, table.number),
    index('flats_floor_id_idx').on(table.floorId),
    check('flats_number_trimmed', sql`${table.number} = btrim(${table.number}) and ${table.number} <> ''`),
    check('flats_carpet_area_positive', sql`${table.carpetAreaSqft} is null or ${table.carpetAreaSqft} > 0`),
    check(
      'flats_sharing_capacity',
      sql`case when ${table.sharingAllowed} then ${table.maxOccupants} is null or ${table.maxOccupants} >= 2 else ${table.maxOccupants} is null end`,
    ),
  ],
)

/** VIEW_ONLY members can read the flat's data but not act on it (pay, approve, create passes). */
export const flatAccess = pgEnum('flat_access', ['FULL', 'VIEW_ONLY'])

/** Links a Resident to a flat for a validity period; active when today is within it. */
export const flatResidents = pgTable(
  'flat_residents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flatId: uuid('flat_id')
      .notNull()
      .references(() => flats.id),
    // No cascade: deleting a flat or user must not silently remove resident history
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Owner or tenant of this flat. Per assignment, not per person: the same user may own one flat and rent another. */
    residentType: residentType('resident_type').notNull(),
    /** How this person relates to the flat: Self, Spouse, Son, Parent. Free text, since a
     * household names these in more ways than an enum can hold. */
    relationship: varchar('relationship', { length: 60 }),
    accessLevel: flatAccess('access_level').notNull().default('FULL'),
    startDate: date('start_date').notNull().default(sql`current_date`),
    /** Last valid day; mandatory for a tenancy, null while an ownership is open-ended */
    endDate: date('end_date'),
    verificationStatus: verificationStatus('verification_status').notNull().default('PENDING'),
    verifiedBy: uuid('verified_by').references(() => users.id),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    rejectedReason: varchar('rejected_reason', { length: 200 }),
    /** Only the document type and its last 4 characters are kept; the file itself comes with uploads */
    idDocumentType: idDocumentType('id_document_type'),
    /** Keyed HMAC-SHA256 of the ID number. The number itself is never stored or returned. */
    idDocumentHash: varchar('id_document_hash', { length: 64 }),
    idDocumentLast4: varchar('id_document_last4', { length: 4 }),
    /** Sale deed, rent agreement or other proof reference recorded by the Admin */
    proofReference: varchar('proof_reference', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('flat_residents_user_id_flat_id_idx').on(table.userId, table.flatId),
    index('flat_residents_flat_id_idx').on(table.flatId),
    check('flat_residents_valid_period', sql`${table.endDate} is null or ${table.endDate} >= ${table.startDate}`),
    check('flat_residents_tenant_end_date', sql`${table.residentType} <> 'TENANT' or ${table.endDate} is not null`),
    check(
      'flat_residents_id_document_hash_sha256',
      sql`${table.idDocumentHash} is null or ${table.idDocumentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    // The verifier and the moment of verification are part of a verified assignment
    check(
      'flat_residents_verified_fields',
      sql`(${table.verificationStatus} = 'VERIFIED') = (${table.verifiedAt} is not null and ${table.verifiedBy} is not null)`,
    ),
    // One live assignment per person and flat: overlapping periods are refused, a later tenancy is not.
    // The EXCLUDE constraint itself is in the migration; Drizzle has no builder for it.
  ],
)

/**
 * One row per login. The session is the refresh-token family: its id is the family id, and
 * every token issued in it lives in refresh_tokens.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // ponytail: nullable until the mobile app sends a device identifier
    deviceId: varchar('device_id', { length: 128 }),
    userAgent: text('user_agent'),
    ipAddress: varchar('ip_address', { length: 45 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: varchar('revoked_reason', { length: 64 }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('auth_sessions_user_id_idx').on(table.userId),
    // A user's live sessions, e.g. for "sign out everywhere" and session lists
    index('auth_sessions_user_id_active_idx').on(table.userId, table.expiresAt).where(sql`${table.revokedAt} is null`),
  ],
)

/**
 * Every refresh token issued for a session (the token family). Rotated tokens are kept
 * so that presenting one again is detected as reuse.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => authSessions.id, { onDelete: 'cascade' }),
    /** SHA-256 of the token; the token itself is never stored */
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set when this token was exchanged for a new one */
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    replacedById: uuid('replaced_by_id').references((): AnyPgColumn => refreshTokens.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('refresh_tokens_session_id_idx').on(table.sessionId),
    // Raw tokens are 43-char base64url, so this rejects anything but a SHA-256 hex digest
    check('refresh_tokens_token_hash_sha256', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
)

/**
 * One-time codes that let a person set their own password: the office issues one for a new
 * account or a forgotten password, and the person spends it on the set-password screen. Only
 * the SHA-256 of the code is stored, as with refresh tokens.
 */
export const passwordSetupCodes = pgTable(
  'password_setup_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the code; the code itself is never stored or logged */
    codeHash: varchar('code_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** The Admin who issued it; null once that account is deleted */
    issuedBy: uuid('issued_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // At most one spendable code per user, so issuing a new one must retire the old one
    uniqueIndex('password_setup_codes_one_live_per_user').on(table.userId).where(sql`${table.usedAt} is null`),
    check('password_setup_codes_code_hash_sha256', sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`),
  ],
)

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null when the actor could not be identified (e.g. unknown phone) */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    /** Never contains passwords or tokens */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_actor_user_id_idx').on(table.actorUserId),
    index('audit_logs_event_type_created_at_idx').on(table.eventType, table.createdAt),
  ],
)

// ---------------------------------------------------------------------------
// Staff: guards on a gate, daily help working for flats, and society vendors
// ---------------------------------------------------------------------------

/**
 * Anyone who works at the society without living there. A guard belongs to a gate and a shift;
 * daily help belongs to the flats it serves. Everyone gets a pass code the guard checks at the
 * gate, valid between the pass dates.
 */
export const staff = pgTable(
  'staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    societyId: uuid('society_id')
      .notNull()
      .references(() => societies.id),
    kind: staffKind('kind').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    phone: varchar('phone', { length: 15 }).notNull(),
    /** Maid, Cook, Driver, Plumber: free text, since a society hires in more ways than an enum holds */
    workType: varchar('work_type', { length: 60 }),
    agency: varchar('agency', { length: 120 }),
    gateId: uuid('gate_id').references(() => gates.id),
    shift: staffShift('shift'),
    policeVerification: policeVerification('police_verification').notNull().default('NOT_STARTED'),
    gender: gender('gender'),
    homeAddress: varchar('home_address', { length: 500 }),
    /** Days of the week worked, as 'MON,TUE,WED'; empty means no fixed days */
    workingDays: varchar('working_days', { length: 27 }),
    /** Identity is kept exactly as a resident's is: type, keyed hash and last 4, never the number */
    idDocumentType: idDocumentType('id_document_type'),
    idDocumentHash: varchar('id_document_hash', { length: 64 }),
    idDocumentLast4: varchar('id_document_last4', { length: 4 }),
    /** Where the photo and the masked ID copy are filed until this deployment stores files */
    photoReference: varchar('photo_reference', { length: 200 }),
    /** What the guard scans or types at the gate; issued on save and never reused */
    passCode: varchar('pass_code', { length: 16 }).notNull().unique(),
    passValidFrom: date('pass_valid_from').notNull().default(sql`current_date`),
    /** Null while the engagement is open-ended */
    passValidUntil: date('pass_valid_until'),
    status: recordStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('staff_society_id_phone_unique').on(table.societyId, table.phone),
    index('staff_society_id_kind_idx').on(table.societyId, table.kind),
    check('staff_phone_digits', sql`${table.phone} ~ '^[6-9][0-9]{9}$'`),
    check('staff_name_trimmed', sql`${table.name} = btrim(${table.name}) and ${table.name} <> ''`),
    check('staff_pass_period', sql`${table.passValidUntil} is null or ${table.passValidUntil} >= ${table.passValidFrom}`),
    check('staff_id_document_hash_sha256', sql`${table.idDocumentHash} is null or ${table.idDocumentHash} ~ '^[0-9a-f]{64}$'`),
    check('staff_working_days', sql`${table.workingDays} is null or ${table.workingDays} ~ '^(MON|TUE|WED|THU|FRI|SAT|SUN)(,(MON|TUE|WED|THU|FRI|SAT|SUN))*$'`),
  ],
)

/** Which flats a staff member works for, and when they are expected. */
export const staffFlats = pgTable(
  'staff_flats',
  {
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    flatId: uuid('flat_id')
      .notNull()
      .references(() => flats.id),
    /** Free text as the resident gives it: "7-9 am", "Mornings" */
    timeWindow: varchar('time_window', { length: 40 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.staffId, table.flatId] }), index('staff_flats_flat_id_idx').on(table.flatId)],
)

// ---------------------------------------------------------------------------
// Billing: the rates in force, the invoices they produced, and payments against them
// ---------------------------------------------------------------------------

/**
 * What the society charges, from a date. A change inserts a new row rather than editing the old
 * one, so an invoice can always be read back against the rate that produced it.
 */
export const billingRates = pgTable(
  'billing_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    societyId: uuid('society_id')
      .notNull()
      .references(() => societies.id),
    chargeBasis: chargeBasis('charge_basis').notNull(),
    /** Rupees per sq ft of carpet area, or per flat, depending on the basis */
    rate: numeric('rate', { precision: 10, scale: 2 }).notNull(),
    sinkingFund: numeric('sinking_fund', { precision: 10, scale: 2 }).notNull().default('0'),
    parkingCharge: numeric('parking_charge', { precision: 10, scale: 2 }).notNull().default('0'),
    /** Day of the month an invoice falls due; capped at 28 so every month has one */
    dueDay: integer('due_day').notNull(),
    lateFeePerDay: numeric('late_fee_per_day', { precision: 10, scale: 2 }),
    effectiveFrom: date('effective_from').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('billing_rates_society_id_effective_from_unique').on(table.societyId, table.effectiveFrom),
    check('billing_rates_due_day', sql`${table.dueDay} between 1 and 28`),
    check('billing_rates_amounts_positive', sql`${table.rate} > 0 and ${table.sinkingFund} >= 0 and ${table.parkingCharge} >= 0`),
    check('billing_rates_late_fee', sql`${table.lateFeePerDay} is null or ${table.lateFeePerDay} >= 0`),
  ],
)

/** One invoice per flat per month. The total is derived, so the parts can never disagree with it. */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    societyId: uuid('society_id')
      .notNull()
      .references(() => societies.id),
    flatId: uuid('flat_id')
      .notNull()
      .references(() => flats.id),
    /** The first day of the month billed */
    period: date('period').notNull(),
    rateId: uuid('rate_id').references(() => billingRates.id),
    maintenance: numeric('maintenance', { precision: 10, scale: 2 }).notNull(),
    sinkingFund: numeric('sinking_fund', { precision: 10, scale: 2 }).notNull().default('0'),
    parkingCharge: numeric('parking_charge', { precision: 10, scale: 2 }).notNull().default('0'),
    oneTimeDescription: varchar('one_time_description', { length: 120 }),
    oneTimeAmount: numeric('one_time_amount', { precision: 10, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 10, scale: 2 }).generatedAlwaysAs(
      sql`maintenance + sinking_fund + parking_charge + one_time_amount`,
    ),
    dueDate: date('due_date').notNull(),
    status: invoiceStatus('status').notNull().default('UNPAID'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('invoices_flat_id_period_unique').on(table.flatId, table.period),
    index('invoices_society_id_period_idx').on(table.societyId, table.period),
    check('invoices_period_is_month_start', sql`date_trunc('month', ${table.period}) = ${table.period}`),
    check(
      'invoices_amounts_not_negative',
      sql`${table.maintenance} >= 0 and ${table.sinkingFund} >= 0 and ${table.parkingCharge} >= 0 and ${table.oneTimeAmount} >= 0`,
    ),
    check('invoices_one_time_described', sql`${table.oneTimeAmount} = 0 or ${table.oneTimeDescription} is not null`),
  ],
)

/**
 * Money received against an invoice. A payment is never deleted: it is reversed, and both the
 * payment and its reversal stay on the record with the receipt number they were issued under.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    receivedOn: date('received_on').notNull(),
    paidBy: varchar('paid_by', { length: 120 }),
    note: varchar('note', { length: 200 }),
    /** Issued by the database, so two admins recording at once can never share a number */
    receiptNumber: varchar('receipt_number', { length: 24 })
      .notNull()
      .unique()
      .default(sql`'RCT-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('receipt_number_seq')::text, 6, '0')`),
    recordedBy: uuid('recorded_by').references(() => users.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => users.id),
    reversalReason: varchar('reversal_reason', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('payments_invoice_id_idx').on(table.invoiceId),
    check('payments_amount_positive', sql`${table.amount} > 0`),
    check('payments_reversal_fields', sql`(${table.reversedAt} is null) = (${table.reversedBy} is null)`),
  ],
)


// ---------------------------------------------------------------------------
// The gate: passes a resident issues, the visits a guard records, and who is inside
// ---------------------------------------------------------------------------

export const visitPurpose = pgEnum('visit_purpose', ['GUEST', 'DELIVERY', 'CAB', 'SERVICE', 'OTHER'])

/** One entry closes the pass on first use; a day pass lets the same person come and go. */
export const visitorPassType = pgEnum('visitor_pass_type', ['ONE_ENTRY', 'MULTI_ENTRY'])

export const visitorPassStatus = pgEnum('visitor_pass_status', ['ACTIVE', 'USED', 'CANCELLED'])

/**
 * A visit's whole life: WAITING on the resident, their decision, then what the gate did.
 * LEAVE_AT_GATE is a delivery the resident will not let upstairs.
 */
export const visitStatus = pgEnum('visit_status', ['WAITING', 'APPROVED', 'LEAVE_AT_GATE', 'DENIED', 'INSIDE', 'LEFT'])

export const vehicleType = pgEnum('vehicle_type', ['CAR', 'BIKE', 'SCOOTER', 'BICYCLE', 'OTHER'])

export const accessRequestKind = pgEnum('access_request_kind', ['HOUSEHOLD_MEMBER', 'DAILY_HELP'])

export const accessRequestStatus = pgEnum('access_request_status', ['PENDING', 'APPROVED', 'REJECTED'])

/** A resident pre-approves someone: the entry code is what the guard checks at the gate. */
export const visitorPasses = pgTable(
  'visitor_passes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    societyId: uuid('society_id')
      .notNull()
      .references(() => societies.id),
    flatId: uuid('flat_id')
      .notNull()
      .references(() => flats.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    visitorName: varchar('visitor_name', { length: 120 }).notNull(),
    visitorPhone: varchar('visitor_phone', { length: 15 }).notNull(),
    purpose: visitPurpose('purpose').notNull().default('GUEST'),
    people: integer('people').notNull().default(1),
    validOn: date('valid_on').notNull(),
    validFrom: time('valid_from').notNull(),
    validUntil: time('valid_until').notNull(),
    vehicleNumber: varchar('vehicle_number', { length: 16 }),
    passType: visitorPassType('pass_type').notNull().default('ONE_ENTRY'),
    /** Shown to the guard when the code is checked: "Parcel can be left with security" */
    note: varchar('note', { length: 200 }),
    /** Six digits the visitor reads out, unique inside the society */
    entryCode: varchar('entry_code', { length: 6 }).notNull(),
    status: visitorPassStatus('status').notNull().default('ACTIVE'),
    usedAt: timestamp('used_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('visitor_passes_society_id_entry_code_unique').on(table.societyId, table.entryCode),
    index('visitor_passes_flat_id_valid_on_idx').on(table.flatId, table.validOn),
    check('visitor_passes_entry_code_digits', sql`${table.entryCode} ~ '^[0-9]{6}$'`),
    check('visitor_passes_phone_digits', sql`${table.visitorPhone} ~ '^[6-9][0-9]{9}$'`),
    check('visitor_passes_people_range', sql`${table.people} between 1 and 50`),
    check('visitor_passes_window', sql`${table.validUntil} > ${table.validFrom}`),
    check('visitor_passes_name_trimmed', sql`${table.visitorName} = btrim(${table.visitorName}) and ${table.visitorName} <> ''`),
  ],
)

/** One person at the gate, from the guard's form to the exit stamp. */
export const visits = pgTable(
  'visits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    societyId: uuid('society_id')
      .notNull()
      .references(() => societies.id),
    gateId: uuid('gate_id').references(() => gates.id),
    flatId: uuid('flat_id')
      .notNull()
      .references(() => flats.id),
    /** Set when the visitor arrived with a pass, so the pass can be closed on entry */
    passId: uuid('pass_id').references(() => visitorPasses.id),
    visitorName: varchar('visitor_name', { length: 120 }).notNull(),
    visitorPhone: varchar('visitor_phone', { length: 15 }).notNull(),
    purpose: visitPurpose('purpose').notNull(),
    company: varchar('company', { length: 120 }),
    people: integer('people').notNull().default(1),
    vehicleNumber: varchar('vehicle_number', { length: 16 }),
    note: varchar('note', { length: 200 }),
    /** Where the gate photo is filed until this deployment stores files */
    photoReference: varchar('photo_reference', { length: 200 }),
    status: visitStatus('status').notNull().default('WAITING'),
    registeredBy: uuid('registered_by').references(() => users.id),
    /** The resident who answered, or the guard who decided after the intercom call */
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: varchar('decision_reason', { length: 200 }),
    enteredAt: timestamp('entered_at', { withTimezone: true }),
    entryBy: uuid('entry_by').references(() => users.id),
    exitedAt: timestamp('exited_at', { withTimezone: true }),
    exitBy: uuid('exit_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('visits_society_id_status_idx').on(table.societyId, table.status),
    index('visits_flat_id_created_at_idx').on(table.flatId, table.createdAt),
    check('visits_phone_digits', sql`${table.visitorPhone} ~ '^[6-9][0-9]{9}$'`),
    check('visits_people_range', sql`${table.people} between 1 and 50`),
    check('visits_decision_recorded', sql`(${table.decidedAt} is null) or (${table.status} <> 'WAITING')`),
    check('visits_exit_after_entry', sql`${table.exitedAt} is null or (${table.enteredAt} is not null and ${table.exitedAt} >= ${table.enteredAt})`),
  ],
)

/** A staff member through the gate: one row per visit, open until the exit is recorded. */
export const staffAttendance = pgTable(
  'staff_attendance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id),
    gateId: uuid('gate_id').references(() => gates.id),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    entryBy: uuid('entry_by').references(() => users.id),
    exitedAt: timestamp('exited_at', { withTimezone: true }),
    exitBy: uuid('exit_by').references(() => users.id),
  },
  (table) => [
    index('staff_attendance_staff_id_entered_at_idx').on(table.staffId, table.enteredAt),
    check('staff_attendance_exit_after_entry', sql`${table.exitedAt} is null or ${table.exitedAt} >= ${table.enteredAt}`),
  ],
)

/** "Not coming today", set by the flat the staff member works for. */
export const staffLeave = pgTable(
  'staff_leave',
  {
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    onDate: date('on_date').notNull(),
    markedBy: uuid('marked_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.staffId, table.onDate] })],
)

/** A resident's vehicles, so the guard lets them in without stopping them. */
export const flatVehicles = pgTable(
  'flat_vehicles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    societyId: uuid('society_id')
      .notNull()
      .references(() => societies.id),
    flatId: uuid('flat_id')
      .notNull()
      .references(() => flats.id),
    number: varchar('number', { length: 16 }).notNull(),
    vehicleType: vehicleType('vehicle_type').notNull().default('CAR'),
    makeColour: varchar('make_colour', { length: 60 }),
    addedBy: uuid('added_by').references(() => users.id),
    status: recordStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('flat_vehicles_society_id_number_unique').on(table.societyId, sql`upper(${table.number})`),
    index('flat_vehicles_flat_id_idx').on(table.flatId),
    check('flat_vehicles_number_trimmed', sql`${table.number} = btrim(${table.number}) and ${table.number} <> ''`),
  ],
)

/** A resident asking the office for a household account or a new daily help. */
export const accessRequests = pgTable(
  'access_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    societyId: uuid('society_id')
      .notNull()
      .references(() => societies.id),
    flatId: uuid('flat_id')
      .notNull()
      .references(() => flats.id),
    kind: accessRequestKind('kind').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    phone: varchar('phone', { length: 15 }).notNull(),
    /** Spouse, Son, Parent for a household member; Maid, Cook, Driver for daily help */
    relationship: varchar('relationship', { length: 60 }),
    accessLevel: flatAccess('access_level'),
    /** "7-9 am", as the resident writes it */
    timings: varchar('timings', { length: 40 }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    status: accessRequestStatus('status').notNull().default('PENDING'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: varchar('decision_reason', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('access_requests_society_id_status_idx').on(table.societyId, table.status),
    index('access_requests_flat_id_idx').on(table.flatId),
    check('access_requests_phone_digits', sql`${table.phone} ~ '^[6-9][0-9]{9}$'`),
    check('access_requests_name_trimmed', sql`${table.name} = btrim(${table.name}) and ${table.name} <> ''`),
  ],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Role = (typeof userRole.enumValues)[number]
export type ResidentType = (typeof residentType.enumValues)[number]
export type FlatResident = typeof flatResidents.$inferSelect
export type Gate = typeof gates.$inferSelect
export type Staff = typeof staff.$inferSelect
export type BillingRate = typeof billingRates.$inferSelect
export type Invoice = typeof invoices.$inferSelect
export type Payment = typeof payments.$inferSelect
export type Visit = typeof visits.$inferSelect
export type VisitorPass = typeof visitorPasses.$inferSelect
export type FlatVehicle = typeof flatVehicles.$inferSelect
export type AccessRequest = typeof accessRequests.$inferSelect
