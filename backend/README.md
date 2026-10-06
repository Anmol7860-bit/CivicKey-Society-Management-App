# CivicKey API

Node.js + Express 5 + TypeScript + PostgreSQL (Drizzle ORM).

## Setup

Needs Node 22+ and PostgreSQL running locally.

```sh
createdb civickey           # dev database
createdb civickey_test      # used by npm test
cp .env.example .env        # then set JWT_ACCESS_SECRET to a long random value
npm install
npm run db:migrate
npm run db:seed             # dev test accounts (refuses to run in production)
npm run dev                 # http://localhost:4000
```

The frontend dev server proxies `/api` to this port.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start with reload |
| `npm test` | Run API tests against `civickey_test` (override with `TEST_DATABASE_URL`) |
| `npm run typecheck` | Type-check |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run db:generate` | Create a migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Create or reset the dev test accounts |

## Seeded accounts

| Login | Password | Role | Active |
|---|---|---|---|
| 9876543210 | Resident@123 | RESIDENT | yes |
| 9876543211 | Guard@123 | GUARD | yes |
| 9876543212 or admin@civickey.local | Admin@123 | ADMIN | yes |
| 9876543213 | Inactive@123 | RESIDENT | no |

## API

All responses use `{ "data": ... }` on success and
`{ "error": { "code", "message", "details?", "retryAfterSeconds?" } }` on failure.

### `POST /api/v1/auth/login`

Body: `{ "phone": "9876543210", "password": "..." }` or `{ "email": "...", "password": "..." }`.

200:

```json
{
  "data": {
    "tokenType": "Bearer",
    "accessToken": "<JWT, 15 min>",
    "expiresIn": 900,
    "user": { "id": "...", "name": "...", "phone": "...", "email": null, "role": "RESIDENT", "societyId": null }
  }
}
```

The refresh token is set as an httpOnly `ck_refresh` cookie scoped to `/api/v1/auth`. Only its SHA-256 hash is stored in `auth_sessions`.

| Status | Code | When |
|---|---|---|
| 401 | `INVALID_CREDENTIALS` | Unknown phone/email or wrong password (same response for both) |
| 403 | `USER_INACTIVE` | Correct password, inactive account |
| 422 | `VALIDATION_ERROR` | Missing/invalid fields, both or neither identifier, unknown fields, bad JSON |
| 429 | `TOO_MANY_REQUESTS` | 5 failed attempts per account + IP, or 50 requests per IP, in 15 minutes |
| 500 | `INTERNAL_ERROR` | Unexpected failure (details logged server-side only) |

### `POST /api/v1/auth/refresh`

No body. Reads the `ck_refresh` cookie and returns the same 200 response as login, with a new access token and a new `ck_refresh` cookie.

Each login creates a session (a token family). Every refresh rotates the token: the old one is marked `rotated_at` and linked to its replacement in `refresh_tokens`. Using a rotated token again is treated as theft. The whole session and all its tokens are revoked (`revoked_reason = REFRESH_TOKEN_REUSE`), and the user must sign in again. Other sessions of the same user are not affected.

| Status | Code | When |
|---|---|---|
| 401 | `INVALID_REFRESH_TOKEN` | Missing, unknown, revoked or reused token |
| 401 | `SESSION_EXPIRED` | Token past its expiry (7 days from last refresh) |
| 403 | `USER_INACTIVE` | User was deactivated after signing in (session is revoked) |

Every 401/403 from this endpoint also clears the cookie.

Clients must not run two refreshes in parallel with the same token: the second one counts as reuse and ends the session. The frontend should share one in-flight refresh request.

### Audit events

Recorded in `audit_logs`: `AUTH_LOGIN_SUCCESS`, `AUTH_LOGIN_FAILED` (with reason), `AUTH_LOGIN_RATE_LIMITED`, `AUTH_REFRESH_FAILED` (with reason), `AUTH_REFRESH_REUSE_DETECTED`. Phone numbers and emails are masked; passwords and tokens are never recorded.
