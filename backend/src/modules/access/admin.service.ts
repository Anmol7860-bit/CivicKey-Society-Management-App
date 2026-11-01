import { randomBytes } from 'node:crypto'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { permissions, roles, userPermissions, userRoles, users } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import type { AuthContext } from '../../middleware/requireAuth.js'
import { recordAuditEvent, type DbExecutor } from '../audit/audit.service.js'
import { decryptIdNumber, identityOf, withoutHash, type IdentityInput } from './identity.js'
import { hashPassword } from '../auth/password.js'
import { issueSetupCode } from '../auth/passwordSetup.js'
import {
  assignRole,
  isResident,
  removeCommitteeMembership,
  setCommitteeMembership,
  type AdminPermission,
  type CommitteePermission,
} from './permissions.js'
import { assertSameSociety, assertState, UUID } from './scope.js'

const userColumns = { id: users.id, name: users.name, phone: users.phone, email: users.email }
/** What a caller may see of the document on file: its type and last 4, never the number */
const identityColumns = {
  idDocumentType: users.idDocumentType,
  idDocumentLast4: users.idDocumentLast4,
  idDocumentHash: users.idDocumentHash,
}

export interface CreateAdminBody extends IdentityInput {
  name: string
  phone: string
  email?: string
  permissions: AdminPermission[]
}

/** The account this Admin is acting on must exist in their own society. */
async function sameSocietyUser(ctx: AuthContext, userId: string) {
  const [user] = UUID.test(userId)
    ? await db.select({ ...userColumns, societyId: users.societyId }).from(users).where(eq(users.id, userId))
    : []
  // A platform-level account belongs to no society, so nobody manages it from a society screen
  if (!user?.societyId) throw new AppError(404, 'NOT_FOUND', 'User not found')
  await assertSameSociety(ctx, user.societyId)
  return user
}

/** Grants the codes, reviving a revoked grant rather than losing the record of the first one. */
async function grant(tx: DbExecutor, actorUserId: string, userId: string, codes: readonly AdminPermission[]) {
  const ids = await tx.select({ id: permissions.id }).from(permissions).where(inArray(permissions.code, [...codes]))
  const now = new Date()
  await tx
    .insert(userPermissions)
    .values(ids.map(({ id }) => ({ userId, permissionId: id, grantedBy: actorUserId, grantedAt: now })))
    .onConflictDoUpdate({
      target: [userPermissions.userId, userPermissions.permissionId],
      set: { grantedBy: actorUserId, grantedAt: now, revokedAt: null },
      // An already active grant keeps its original granter and time
      setWhere: sql`${userPermissions.revokedAt} is not null`,
    })
}

/**
 * Creates the office account an Admin signs in with, or gives the chosen permissions to the
 * account that already holds this mobile number, which is how a resident becomes an Admin
 * without a second account. A brand-new account has no usable password and leaves with a
 * one-time code, exactly as a resident registration does.
 */
export function createAdminAccount(ctx: AuthContext, societyId: string, body: CreateAdminBody) {
  return db.transaction(async (tx) => {
    await assertSameSociety(ctx, societyId)
    const [existing] = await tx
      .select({ ...userColumns, societyId: users.societyId, isActive: users.isActive })
      .from(users)
      .where(eq(users.phone, body.phone))
    if (existing) {
      assertState(existing.societyId === societyId, 'This mobile number is registered in another society')
      assertState(existing.isActive, 'This account is deactivated')
    }

    // The office saw the document just now, so it is recorded either way
    const identity = identityOf(body)
    let user = existing && { id: existing.id, name: existing.name, phone: existing.phone, email: existing.email }
    if (user) await tx.update(users).set({ ...identity, updatedAt: new Date() }).where(eq(users.id, user.id))
    if (!user) {
      try {
        ;[user] = await tx
          .insert(users)
          .values({
            name: body.name,
            phone: body.phone,
            email: body.email ?? null,
            societyId,
            ...identity,
            // Unusable by design: the account gets in through the one-time code issued below
            passwordHash: await hashPassword(randomBytes(32).toString('hex')),
          })
          .returning(userColumns)
      } catch (error) {
        const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code
        if (code === '23505') throw new AppError(409, 'ALREADY_EXISTS', 'This email is already registered')
        throw error
      }
    }

    await grant(tx, ctx.userId, user!.id, body.permissions)
    await assignRole(tx, user!.id, 'ADMIN')
    await recordAuditEvent(tx, {
      eventType: 'ADMIN_ACCOUNT_CREATED',
      actorUserId: ctx.userId,
      metadata: { userId: user!.id, societyId, permissions: [...body.permissions].sort(), newAccount: !existing },
    })
    const loginCode = existing ? null : await issueSetupCode(ctx, user!.id, tx)
    return {
      user: { ...user!, idDocumentType: identity.idDocumentType, idDocumentLast4: identity.idDocumentLast4, idDocumentOnFile: true },
      permissions: [...body.permissions].sort(),
      loginCode,
    }
  })
}

/** Everyone in the society holding the ADMIN role, with the permissions they hold today. */
export async function listAdmins(ctx: AuthContext, societyId: string) {
  await assertSameSociety(ctx, societyId)
  const rows = await db
    .select({ ...userColumns, isActive: users.isActive, ...identityColumns })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(users.societyId, societyId), eq(roles.name, 'ADMIN')))
    .orderBy(asc(users.name))
  if (rows.length === 0) return []

  const ids = rows.map((row) => row.id)
  const granted = await db
    .select({ userId: userPermissions.userId, code: permissions.code })
    .from(userPermissions)
    .innerJoin(permissions, eq(permissions.id, userPermissions.permissionId))
    .where(and(inArray(userPermissions.userId, ids), isNull(userPermissions.revokedAt)))
  // A committee member is an Admin who also lives here; a staff Admin holds no flat
  const resident = await Promise.all(rows.map((row) => isResident(db, row.id)))

  return rows.map((row, index) => ({
    ...withoutHash(row),
    resident: resident[index]!,
    permissions: granted
      .filter((row_) => row_.userId === row.id)
      .map((row_) => row_.code)
      .sort(),
  }))
}

/**
 * The Admin's captured ID number, for the one read that may see it.
 *
 * Recoverable because the society may have to produce the document it recorded, and audited for
 * exactly the same reason: who read it and why is part of the record.
 */
export function revealUserIdNumber(ctx: AuthContext, userId: string, reason: string) {
  return db.transaction(async (tx) => {
    const target = await sameSocietyUser(ctx, userId)
    const [row] = await tx
      .select({ idDocumentType: users.idDocumentType, idDocumentEncrypted: users.idDocumentEncrypted })
      .from(users)
      .where(eq(users.id, target.id))
    assertState(row?.idDocumentEncrypted != null, 'No ID document is on file for this account')
    await recordAuditEvent(tx, {
      eventType: 'USER_ID_REVEALED',
      actorUserId: ctx.userId,
      metadata: { userId, idDocumentType: row!.idDocumentType, reason },
    })
    return { idDocumentType: row!.idDocumentType, idNumber: decryptIdNumber(row!.idDocumentEncrypted) }
  })
}

/** Committee permissions for a resident of this society; replaces whatever they held before. */
export async function assignCommittee(ctx: AuthContext, userId: string, granted: readonly CommitteePermission[]) {
  await sameSocietyUser(ctx, userId)
  await setCommitteeMembership(ctx.userId, userId, granted)
  return listCommitteeGrants(userId)
}

/** Ends committee membership; the person keeps their flat and their resident functions. */
export async function endCommittee(ctx: AuthContext, userId: string) {
  await sameSocietyUser(ctx, userId)
  await removeCommitteeMembership(ctx.userId, userId)
  return listCommitteeGrants(userId)
}

async function listCommitteeGrants(userId: string) {
  const rows = await db
    .select({ code: permissions.code })
    .from(userPermissions)
    .innerJoin(permissions, eq(permissions.id, userPermissions.permissionId))
    .where(and(eq(userPermissions.userId, userId), isNull(userPermissions.revokedAt)))
  return { userId, permissions: rows.map((row) => row.code).sort() }
}
