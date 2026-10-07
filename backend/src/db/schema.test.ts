import { pool } from './client.js'
import { createUser } from '../test/helpers.js'
import { generateRefreshToken, hashRefreshToken } from '../modules/auth/tokens.js'

const inSevenDays = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

async function insertSession(userId: string) {
  const { rows } = await pool.query<{ id: string }>(
    'insert into auth_sessions (user_id, expires_at) values ($1, $2) returning id',
    [userId, inSevenDays()],
  )
  return rows[0]!.id
}

function insertToken(sessionId: string, tokenHash: string) {
  return pool.query('insert into refresh_tokens (session_id, token_hash, expires_at) values ($1, $2, $3)', [
    sessionId,
    tokenHash,
    inSevenDays(),
  ])
}

describe('auth_sessions / refresh_tokens schema', () => {
  it('stores a SHA-256 hash and rejects a raw refresh token', async () => {
    const sessionId = await insertSession((await createUser()).id)
    const token = generateRefreshToken()

    await expect(insertToken(sessionId, hashRefreshToken(token))).resolves.toBeDefined()
    await expect(insertToken(sessionId, token)).rejects.toMatchObject({
      code: '23514',
      constraint: 'refresh_tokens_token_hash_sha256',
    })
  })

  it('requires an expiry on sessions and tokens', async () => {
    const user = await createUser()
    const sessionId = await insertSession(user.id)

    await expect(pool.query('insert into auth_sessions (user_id) values ($1)', [user.id])).rejects.toMatchObject({
      code: '23502',
      column: 'expires_at',
    })
    await expect(
      pool.query('insert into refresh_tokens (session_id, token_hash) values ($1, $2)', [
        sessionId,
        hashRefreshToken(generateRefreshToken()),
      ]),
    ).rejects.toMatchObject({ code: '23502', column: 'expires_at' })
  })

  it('rejects a session for a user that does not exist', async () => {
    await expect(insertSession('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: '23503',
      constraint: 'auth_sessions_user_id_users_id_fk',
    })
  })

  it('deletes a user’s sessions and tokens with the user', async () => {
    const user = await createUser()
    await insertToken(await insertSession(user.id), hashRefreshToken(generateRefreshToken()))

    await pool.query('delete from users where id = $1', [user.id])

    const { rows } = await pool.query('select (select count(*) from auth_sessions)::int as sessions, (select count(*) from refresh_tokens)::int as tokens')
    expect(rows[0]).toEqual({ sessions: 0, tokens: 0 })
  })

  it('has the lookup indexes', async () => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where tablename in ('auth_sessions', 'refresh_tokens')",
    )
    const indexes = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]))

    expect(Object.keys(indexes).sort()).toEqual([
      'auth_sessions_pkey',
      'auth_sessions_user_id_active_idx',
      'auth_sessions_user_id_idx',
      'refresh_tokens_pkey',
      'refresh_tokens_session_id_idx',
      'refresh_tokens_token_hash_unique',
    ])
    expect(indexes.auth_sessions_user_id_active_idx).toContain('WHERE (revoked_at IS NULL)')
  })
})
