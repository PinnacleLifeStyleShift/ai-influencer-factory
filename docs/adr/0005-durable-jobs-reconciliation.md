# ADR 0005: Durable generation jobs, uncertain outcomes and reconciliation

Status: accepted (reversible). Date: 2026-11-09.

## Context

A paid provider call can die at any point: before money is reserved, after the provider has accepted the work, after the result is stored, or before it is applied. A plain retry after an uncertain failure can buy the same work twice. The brief (section 8) asks that recovery never duplicates a purchase or overwrites newer work.

## Decision

- **Journal.** Each paid workflow is a `generation_jobs` row, with one `generation_steps` row per paid step. A step's state is written **before** the next irreversible action: `reserved`, then `submitting` before the request is sent, then `accepted` with the provider's request id, then `succeeded` once settled, then `applied`.
- **Leases and fencing.** A job has a lease owner and expiry (20 minutes, the same as the item claim). Every step write is conditional on the lease owner, so a worker presumed dead cannot overwrite what recovery decided (`JOB_LEASE_LOST`).
- **Recovery** runs at startup and from the screen (`POST /api/generation-jobs/recover`) for running jobs whose lease has expired:
  - a step never marked `submitting` was provably never sent, so its money is released (`not_submitted`);
  - a step marked `submitting` or `accepted` may have run, so its money **stays counted** (`outcome_unknown`) and the same idempotency key is refused (`DUPLICATE_IN_PROGRESS`) until it is reconciled;
  - a settled result that was never applied is applied on retry without a new purchase.
- **Reconciliation.**
  - *Provider check:* only for adapters with a status lookup. If the provider reports success with a safe URL, the result is recovered and the reservation is settled.
  - *Operator resolution (owner only):* not charged, charged with no result, or charged with a result URL. Each needs 10+ characters of evidence and an optional actual cost. It is decided once, and recorded in `reconciliation_records` with who and when. "Not charged" releases the money and allows a new purchase.
- **Ledger rules.** Settlement happens only from `reserved` or `outcome_unknown`; it is final and the actual cost is never negative. Reconciliation always uses the Postgres ledger, because jobs live in Postgres, even if the gate itself runs with the default (refusing) in-memory ledger.
- **Pricing context.** Paid calls need `PRICE_CURRENCY`, `PRICE_VERSION` and `SPEND_CAP_TIMEZONE` (an IANA zone that defines "day" and "month" for caps). The first two are stored on every reservation.
- **Vendor idempotency.** Adapters that declare `capabilities.vendorIdempotency` receive a stable key derived from the step's local key. No real adapter declares it yet: that needs each provider's documentation checked.
- **Approved content.** Regenerating an approved item needs `confirmReplaceApproved` (otherwise `APPROVED_CONTENT`); scheduled items are still refused.

## Not decided here

- **Provider lookups:** which real providers support status lookups or idempotency keys. This needs verified documentation and owner approval of each adapter.
- **Owner values:** the currency, price version and cap timezone. These are owner decisions and stay empty in `.env.example`.
