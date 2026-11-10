# ADR 0001: Interim identity, sessions and authorization

Status: accepted (interim, reversible). Date: 2026-11-09.

## Context

PR #1 protects `/api` with a single owner bearer token. That cannot expire, cannot be revoked short of rotating it, and gives every caller every right. Choosing a real login provider (accounts, SSO, passkeys) is an owner decision that has not been made. The build brief asks for an auth-provider interface, session revocation and server-side authorization now, using synthetic credentials.

## Decision

- **Providers** (`backend/src/auth/providers.js`): `{ name, authenticate(credential) -> principal | null }`. The only provider today is `owner-token`, which turns `OWNER_API_TOKEN` into the `owner` principal. A future login provider is another implementation; nothing after sessions changes.
- **Sessions** (`backend/src/auth/sessions.js`, `sessions` table):
  - `POST /api/auth/session` exchanges a provider credential for a random `ses_…` token. Only its SHA-256 hash is stored.
  - Sessions expire (`SESSION_TTL_HOURS`, default 12, at most 168).
  - Revocation: `POST /api/auth/logout` revokes one session; `POST /api/auth/sessions/revoke-all` (admin) revokes all sessions for the principal.
  - The owner token is accepted **only** at the exchange route. Every other route needs a session, so access can be cut without rotating the root credential.
- **Authorization** (`backend/src/auth/permissions.js`): one ordered rule table maps method + path to the permissions it needs, and is checked on the server after authentication. The catch-all rules (GET needs `read`, anything else needs `edit`) mean a new route cannot go unchecked.
  - Roles: `owner` (everything); `editor` (read, edit, schedule, references, generate); `reviewer` (read, approve).
  - **`spend` is separate and owner-only**, so editorial rights never allow a paid provider call.
- **Workspace:** each session carries a `workspaceId` (`default`). There is no workspace table, signup or billing yet. Multi-workspace isolation needs object-level `workspaceId` filters and is deliberately not built (single-owner product).

## Consequences

- The frontend prompts for the owner token once, exchanges it, and keeps only the session token in `sessionStorage`.
- Scripts must do the exchange too; the CI smoke test shows how.
- Rotating `OWNER_API_TOKEN` stops new sessions but does not end existing ones; use revoke-all.
- Limits that remain:
  - Only one human identity exists, so the `editor` and `reviewer` roles can only be exercised by sessions created in tests.
  - There is no audit log of who did what yet (planned with the AuditEvent record).
  - Rate limits are in-memory and per process.
