# ADR 0007: Publishing interfaces (disabled), per-destination delivery, reconciliation

Status: accepted (reversible). Date: 2026-11-10.

## Context

Brief section 10 asks for publishing interfaces and mock tests now, with the live publisher disabled. Activation needs:

- an approved account;
- verified official API eligibility and scopes;
- real content and destination approval;
- spending approval where it applies.

It must also:

- model destination-specific delivery, remote post id, permalink, uncertain outcomes and reconciliation;
- treat one cross-platform job as one original, not several;
- never retry a destination that already succeeded.

## Decision

- **Adapter contract** (`services/publishers.js`):
  - `publish(payload, ctx)` returns `published` (with remote post id and permalink) or `processing`.
  - `ctx.clientRef` is a stable key per attempt, sent as the platform's idempotency key where supported.
  - `ctx.onAccepted(id)` records the platform's request id the moment it is accepted.
  - An adapter throws `notSubmitted` **only** when the request provably never left; every other failure is "outcome unknown".
  - `lookup()` is optional and used for reconciliation.
- **No real adapter exists.** TikTok, Instagram and YouTube are registered as *not implemented*.
- **Gate** (`services/publishingGate.js`). A real delivery needs all of:
  - an implemented adapter;
  - `LIVE_PUBLISHING=enabled`;
  - the destination in `APPROVED_PUBLISH_DESTINATIONS`;
  - a `PUBLISH_ACCOUNTS` entry (JSON, no secrets) with `accountRef`, verified `scopes`, `eligibilityVerifiedAt` (not in the future) and `approvalReference`.
  - Every approved destination is checked before anything is written. `GET /api/publishing/policy` lists what is missing per destination.
  - A paid boost is out of scope: no spending path exists.
- **Simulation** (`PUBLISHING_SIMULATION=enabled`): every adapter becomes a simulator. Results are stored and shown as **simulated** (state `simulated`, with fake ids and links on `example.test`). They never mark content published.
- **Content and destination approval:**
  - The destinations are the approved primary platform plus `crossPostDestinations`. Those are in the approval snapshot hash (only when non-empty, so older hashes don't change).
  - Publishing also requires the calendar fence (`assertDeliverable`), the approved time to have arrived (`NOT_YET_DUE`), and a verified export of exactly this snapshot (`EXPORT_REQUIRED`).
  - A multi-shot package needs one rendered file (`RENDER_REQUIRED`).
  - The payload is the checksummed media from the export, plus a text that contains the caption, the **synthetic-persona disclosure** and the hashtags, with `aiGenerated: true`.
- **One original, one job.** A `publish_jobs` row is unique per calendar entry. `publish_deliveries` has one row per destination, holding: state, attempt, clientRef, remote request id, remote post id, permalink, account reference and simulated flag.
- **Journal and fencing:**
  - A delivery is marked `submitting` before the call.
  - Writes are fenced by the job lease (`PUBLISH_IN_PROGRESS` for a second instance).
  - The calendar fence is re-checked before each destination, so a cancellation stops the ones not yet sent.
- **Retry rules:**
  - `published` and `simulated` deliveries are never sent again.
  - `failed` means provably refused before sending, and may be retried with a new attempt key.
  - `outcome_unknown`, `submitting` and `processing` block the whole job (`RECONCILIATION_REQUIRED`) until reconciled.
- **Recovery** (startup and `POST /api/publishing/recover`): a delivery left `submitting` by a dead process becomes `outcome_unknown`; it is never re-posted automatically. Deliveries never marked stay `pending` (provably not sent).
- **Reconciliation:**
  - a platform check (adapters with lookups): "published" with an id settles it; "failed" means not published; "not found" is **not** proof and stays pending;
  - owner resolution with evidence: "not published" allows one new attempt; "published" needs the post id and an https link.
  - Both are recorded in `publish_reconciliations`.
- **What the calendar says:**
  - `published` (and the item's stage `published`) only when **every** destination is platform- or owner-confirmed.
  - `partially_published` as soon as any destination is confirmed out, even if others are pending, unknown or cancelled. A post that is out is never shown as cancelled.
  - Published items and entries cannot be edited, cancelled or deleted.
- **Permissions:** posting is owner-only (`publish`); reconciliation and recovery need `admin`; reading is open.

## Not decided here

- **Real adapters per platform:** official API, account, scopes, review status and rate limits. These need the owner's decisions and verified documentation.
- **Scheduling:** an automatic "post at the approved time" worker. Today it's a manual owner action at or after the time; a worker would call the same `publishContent`.
- **Measurement** (the second half of section 10): metrics sources, reporting periods and campaign money states. This is the next package.
