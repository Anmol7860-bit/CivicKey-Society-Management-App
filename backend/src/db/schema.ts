import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  unique,
  text,
  timestamp,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

export const userRole = pgEnum('user_role', ['RESIDENT', 'GUARD', 'ADMIN'])

/** A Resident's classification, not a role. Kept while a Resident serves on the committee (role ADMIN). */
export const residentType = pgEnum('resident_type', ['OWNER', 'TENANT'])

export const societies = pgTable('societies', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 160 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
    residentType: residentType('resident_type'),
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

export const flats = pgTable(
  'flats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    societyId: uuid('society_id')
      .notNull()
      .references(() => societies.id),
    block: varchar('block', { length: 32 }).notNull(),
    number: varchar('number', { length: 16 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('flats_society_block_number_unique').on(table.societyId, table.block, table.number)],
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
      .references(() => flats.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessLevel: flatAccess('access_level').notNull().default('FULL'),
    startDate: date('start_date').notNull().default(sql`current_date`),
    /** Last valid day; null while open-ended */
    endDate: date('end_date'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('flat_residents_user_id_flat_id_idx').on(table.userId, table.flatId),
    check('flat_residents_valid_period', sql`${table.endDate} is null or ${table.endDate} >= ${table.startDate}`),
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
