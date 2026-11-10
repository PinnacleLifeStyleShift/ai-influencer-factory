# ADR 0002: Audit trail, request validation and safe errors

Status: accepted (reversible). Date: 2026-11-09.

## Audit trail

- **What is recorded:** every non-GET `/api` request, including ones refused before authentication or authorization, is written to `audit_events` after its response finishes. Each row holds actor id and role, session id, action (method + **route pattern**, e.g. `POST /api/pipeline/:id/approve`), target type and id, HTTP status, outcome (success / denied / failed), error code and correlation id.
- **Redaction:**
  - Request bodies, query strings, headers, tokens and provider payloads are never recorded.
  - Requests refused before routing have id-like path segments replaced with `:id`, so raw ids appear only in `targetId`.
- **Why after the fact and best effort:** the recorded status is then the real outcome, and a failed audit write cannot turn a completed action into an error. It is operator evidence, not a tamper-proof ledger.
- **Domain events:** paid-generation evidence stays in `generation_reservations` and `generation_applications`; the audit row links to them by target id and correlation id.
- `GET /api/audit-events` is admin-only (newest first, `?before=`, `?targetId=`, bounded `?limit=`).

## Request validation

- **Legacy CRUD routes** (characters, content, campaigns, submissions) validate every supplied field's type, length and allowed values with a small in-repo validator (`backend/src/lib/validate.js`). It accepts the snake_case and camelCase names those routes already use.
- **Failures:** all problems are returned at once (`VALIDATION_FAILED`, `details.fields`).
- **Unknown keys** are ignored, because the routes never copy them.
- **Why not a schema library:** the routes map fields by hand. A library would have meant rewriting them in this package, and the next packages replace these models anyway.
- **URL fields** (reference images, submissions) go through the SSRF check.

## Lists

List routes take `?limit=1..500` (default 200) and refuse anything else. The dashboard still reads full tables to compute totals; it moves to aggregate queries when metrics are rebuilt (Package E and later).

## Errors

- **One error path for every route** (`routeError`):
  - `ApiError` → its own code.
  - Prisma not-found → `404 NOT_FOUND`.
  - Unique violation → `409 CONFLICT`.
  - Missing reference → `400 VALIDATION_FAILED`.
  - Anything else → `500 INTERNAL_ERROR`.
- **Every error body carries `requestId`.**
- **Logs** keep the error code and the first line of the message only, never the error object (which can include query values).

## Uploads, browser exposure

- **Uploads:** there are no upload routes yet. JSON bodies are limited to 100 kB. Any future upload route must enforce type and size limits and store files privately (Package B/E).
- **Browser exposure:**
  - The app has no analytics or third-party scripts.
  - Tokens never appear in URLs or browser history: the session lives in `sessionStorage`, and the owner token is never stored.
  - Responses send `Referrer-Policy: no-referrer`.
  - The only query strings are list filters (month, character, stage).
