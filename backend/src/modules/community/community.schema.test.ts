import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { blocks, communityGroupMembers, communityGroups, communityMessages, type CommunityGroup } from '../../db/schema.js'
import { createUser, TEST_SOCIETY_ID } from '../../test/helpers.js'

/** Drizzle wraps a database error; the constraint name is on its cause. */
async function failure(query: Promise<unknown>) {
  try {
    await query
    return 'the query succeeded'
  } catch (error) {
    return String((error as { cause?: unknown }).cause ?? error)
  }
}

/** The community space leans on database constraints, so these pin the rules the API relies on. */
describe('community group constraints', () => {
  const group = (overrides: Partial<CommunityGroup> & { name: string }) =>
    db
      .insert(communityGroups)
      .values({ societyId: TEST_SOCIETY_ID, ...overrides })
      .returning()

  it('ties a block to the BLOCK scope and to no other', async () => {
    await createUser()
    const [block] = await db.insert(blocks).values({ societyId: TEST_SOCIETY_ID, name: 'C' }).returning()

    expect(await failure(group({ name: 'Block C', scope: 'BLOCK' }))).toMatch(/block_matches_scope/)
    expect(await failure(group({ name: 'Sports', scope: 'CUSTOM', blockId: block!.id }))).toMatch(/block_matches_scope/)
    await expect(group({ name: 'Block C', scope: 'BLOCK', blockId: block!.id })).resolves.toHaveLength(1)
  })

  it('allows one live society channel and one per block', async () => {
    await createUser()
    await group({ name: 'Everyone', scope: 'SOCIETY' })
    expect(await failure(group({ name: 'Everyone again', scope: 'SOCIETY' }))).toMatch(/one_society_channel/)

    // Archiving the first frees the slot
    await db.update(communityGroups).set({ archivedAt: new Date() }).where(eq(communityGroups.name, 'Everyone'))
    await expect(group({ name: 'Everyone again', scope: 'SOCIETY' })).resolves.toHaveLength(1)
  })

  it('keeps one live membership row per person, and lets a removed one come back', async () => {
    const user = await createUser()
    const [sports] = await group({ name: 'Sports' })
    const member = { groupId: sports!.id, userId: user.id }

    await db.insert(communityGroupMembers).values({ ...member, role: 'LEADER' })
    expect(await failure(db.insert(communityGroupMembers).values(member))).toMatch(/one_live_per_user/)

    await db.update(communityGroupMembers).set({ removedAt: new Date() }).where(eq(communityGroupMembers.userId, user.id))
    await expect(db.insert(communityGroupMembers).values(member).returning()).resolves.toHaveLength(1)
  })

  it('refuses an empty message and a half-recorded deletion', async () => {
    const user = await createUser()
    const [sports] = await group({ name: 'Sports' })
    const message = { groupId: sports!.id, authorId: user.id, body: 'Match at 7' }

    expect(await failure(db.insert(communityMessages).values({ ...message, body: '   ' }))).toMatch(/body_present/)
    await db.insert(communityMessages).values(message)
    const halfDeleted = db.update(communityMessages).set({ deletedAt: new Date() }).where(eq(communityMessages.groupId, sports!.id))
    expect(await failure(halfDeleted)).toMatch(/deletion_recorded/)
  })
})
