import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
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

export const societies = pgTable('societies', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 160 }).notNull(),
  address: varchar('address', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

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
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('users_login_identifier_present', sql`${table.phone} is not null or ${table.email} is not null`),
    check('users_email_lowercase', sql`${table.email} = lower(${table.email})`),
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

/** Lifecycle of society structure records. Nothing is physically deleted. */
export const recordStatus = pgEnum('record_status', ['ACTIVE', 'INACTIVE'])

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

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Role = (typeof userRole.enumValues)[number]
export type ResidentType = (typeof residentType.enumValues)[number]
export type FlatResident = typeof flatResidents.$inferSelect
