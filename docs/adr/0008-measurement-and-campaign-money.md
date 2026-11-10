# ADR 0008: Measurement with provenance; campaign money in three states

Status: accepted (reversible). Date: 2026-11-10.

## Context

Brief section 10 (second half):

- Metrics must separate fixture, manual and API-observed sources, and cumulative counters from selected-period activity.
- Reports must show the reporting period, time zone, refresh date and missing coverage.
- Revenue must never be attributed by invention.
- Campaign planned payout, invoice and cash received are separate states.
- No automated DMs, likes, follower growth or deceptive persona claims.

**Before this package:**

- The dashboard summed `content.views` and character profile counters, which had no source or date.
- It showed a "Total Earned" built from planned submission payouts.

## Decision

### Readings (`metric_observations`, append-only)

- **Every reading records:** subject (a platform-confirmed post or a character's account on a platform), metric, kind (`cumulative` "as of" a time, or `period` covering a window), value, observed time, **source** (`manual`, `api`, `fixture`), where it was read, who recorded it and when.
- **Who can write what:**
  - `manual` needs a description of where it was read.
  - `api` can only come from an approved provider; the HTTP route refuses it.
  - `fixture` is labelled and excluded from reports unless asked for.
- **Checks:**
  - Simulated or unconfirmed posts cannot be measured.
  - No future times, and no period that hasn't ended.
  - A reading cannot predate the post.
  - Followers are cumulative only.
- **Duplicates and corrections:**
  - Repeating the same reading is idempotent; a different value for the same reading is a conflict.
  - A wrong reading is **retracted with a reason** and kept. Retraction frees its key, so the correction can be recorded.

### Report (`GET /api/metrics/report`)

- **Inputs:** inclusive local dates and a canonical IANA zone. The window is computed with the same DST-safe code as scheduling; for example, 1 Nov 2026 in Los Angeles is 25 hours.
- **Per subject, metric and source** (sources are never mixed or added):
  - the total as of the period end, with its time;
  - the change between the first and last snapshots inside the period, with both times;
  - activity from period readings **fully inside** the window, with the share of the window covered and its gaps;
  - readings crossing the edge are counted as excluded, not split;
  - counters that go down are flagged.
- **The report also states:**
  - its window in UTC;
  - the last refresh time per source;
  - originals versus posts (one cross-posted original is one original);
  - posts without any reading;
  - whether the period is still running.
- **No revenue:** the report contains no revenue field.

### Platform analytics

- **Provider interface** (`services/metricsProviders.js`): none is implemented.
- **Refreshing** needs `METRICS_API=enabled` and an implemented, approved provider; otherwise it returns `METRICS_API_DISABLED` and the screen says "not connected". Only confirmed real posts of the provider's platform are sent to it.

### Campaign money

- **Planned:** the campaign's offered payout, labelled "a plan, not income".
- **Invoices:** number unique per campaign, positive amount, ISO currency, issue date not in the future. Voided with a reason, never deleted. An invoice with receipts against it cannot be voided until they are reversed.
- **Receipts:** amount, currency (must match the invoice if linked), received date, payment reference and **evidence**. Reversed with a reason, never deleted.
- **Summary per currency:** planned, invoiced, received, outstanding and overpaid. Nothing is "earned" until received.
- **Who can record:** money records are owner-only (`admin`).
- **Deletion:** a campaign with money records cannot be deleted.

### Honest dashboard

- **Published:** the count covers only platform-confirmed posts; partly published and planned are shown separately.
- **Money:** shown by state; the old "Total Earned" is removed.
- **Views chart:** replaced by a measurement summary (confirmed posts, posts without readings, last reading per source).
- **Character profile counters:** marked as self-reported.
- **Calendar counters:** calendar content no longer accepts bare view or like counters (`METRICS_USE_READINGS`).

## Not decided here

- **Platform analytics provider:** which official API and account, and whether analytics access costs money. These are owner decisions.
- **Sponsor authorization:** a record linking a campaign to a real, authorized sponsor agreement and its disclosure. This is noted for operational hardening.
- **Legacy profile counters:** kept and labelled as self-reported; not migrated into readings, because they have no date or source.
