# SMB-2 — Authentication session conformance

Living record of what the code does, against Solution Design Document v4.0 and the
decisions taken since. Nothing here is implemented from the document alone: where the
document and the confirmed direction differ, the difference is listed as a gap and left
for Jira to settle.

## Current direction

| Item | Direction | State |
| --- | --- | --- |
| Access-token lifetime | **6 hours**, confirmed by the mentor; supersedes the earlier 15-minute setting and the document's 30 minutes | Done — `ACCESS_TOKEN_TTL_SECONDS=21600` |
| After expiry | The refresh token mints a new access token; the user is not asked to sign in again | Done |
| Refresh rotation | Every refresh issues a new token and marks the old one used | Done |
| Reuse / replay | An already-rotated token revokes the whole session and its token family | Done |
| Logout | Revokes the session and every refresh token in its family, and clears the cookie | Done |
| Page reload | Restores the session from the HttpOnly cookie through one rotation; never revokes | Done |

### Where it lives

- `backend/src/config/env.ts` — `ACCESS_TOKEN_TTL_SECONDS` (default 21600), `REFRESH_TOKEN_TTL_DAYS`
- `backend/src/modules/auth/auth.service.ts` — login, refresh with rotation and reuse detection, logout
- `backend/src/modules/auth/auth.routes.ts` — refresh cookie: HttpOnly, SameSite=Strict, Secure in production, scoped to `/api/v1/auth`
- `frontend/src/App.tsx` — refreshes 60 s before expiry; one refresh at a time, serialised across tabs by a Web Lock

### Tests covering it

| Behaviour | Test |
| --- | --- |
| Login returns a 6-hour token, and the JWT `exp − iat` is 21600 | `backend/src/modules/auth/login.test.ts` |
| Refresh returns a new 6-hour token for the same session | `backend/src/modules/auth/refresh.test.ts` |
| Rotation stores only the new hash, and each new token works once | `backend/src/modules/auth/refresh.test.ts` |
| Reuse revokes the session, and leaves other sessions alone | `backend/src/modules/auth/refresh.test.ts` |
| Two concurrent refreshes with one token: only one succeeds | `backend/src/modules/auth/refresh.test.ts` |
| Logout revokes the session and all its refresh tokens, and is idempotent | `backend/src/modules/auth/logout.test.ts` |
| A revoked session's unexpired access token is refused | `backend/src/middleware/requireAuth.test.ts` |
| Reload keeps the user signed in | `frontend/e2e/auth.e2e.ts` AUTH-UI-024 |
| The token is swapped shortly before the 6 hours are up | `frontend/e2e/auth.e2e.ts` AUTH-UI-020 |
| A replayed refresh token returns the browser to login with a message | `frontend/e2e/auth.e2e.ts` AUTH-UI-021 |

## Gaps against Document v4.0 — not implemented, awaiting Jira

| Document v4.0 | Code today | Note |
| --- | --- | --- |
| Access token 30 minutes | 6 hours | Superseded by the confirmed direction above |
| Rotating refresh token 30 days | 7 days (`REFRESH_TOKEN_TTL_DAYS`) | One config value; no change made without a ticket |
| Guard session capped at 12 hours, re-login at the shift boundary | Not implemented; a guard's session behaves like any other | Needs a decision: a cap per role touches session issuing |
| `GET /me` returning the safe profile | `GET /auth/permissions` serves the same need | No second endpoint added |
