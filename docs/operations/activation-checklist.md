# Activation checklist (prepared, not executed)

Spec of 11 November 2026, priority step 5. Each capability below is **off in production** and stays off until the owner approves its own section. Approving one does not approve another. Every switch is an environment variable on the Railway **api** service, so turning it off again is the same change reversed, and no migration depends on any of them.

**Costs:** none are estimated here, because there is no billing evidence. Each section names what must be priced from the provider's or Railway's own pricing page before approval.

**Before any activation:**
- take a database backup of the **Postgres** service (the one the API uses, by its `postgres` private endpoint);
- note the current `main` revision.

---

## A. Media storage and assembly (export of real media)

**Unlocks:**
- measuring and exporting real files;
- assembling multi-shot packages into one video, with recorded lineage (AIF 1).

**Proposed configuration** (names as implemented; values are owner decisions):

| Variable | Meaning |
| --- | --- |
| `MEDIA_STORE` | Storage backend. Only the local/fixture adapter exists today. A private object store needs an adapter: storage isolation, expiring private downloads, SSRF-checked redirects, size and time limits. Build that before activation. |
| `MEDIA_ASSEMBLY=ffmpeg` | Turns on local deterministic assembly. **The production image has no ffmpeg:** add it to `backend/Dockerfile` (one `apk add ffmpeg` line, as CI does) in a reviewed PR first. |
| `RETENTION_POLICY` | JSON with days per category (originalReferences, renderedExports, auditTrail, jobAndMoneyEvidence). Unset means nothing is deleted. |

**Resources to price before approval:**
- a Railway volume or bucket for media, with its size;
- the larger image (ffmpeg adds roughly 30–80 MB to the image);
- CPU time for encoding.

**Rollback:** unset the variables. Exports then refuse with `MEDIA_STORE_NOT_CONFIGURED`, and stored files and lineage rows remain.

**Operator acceptance:**
1. Assemble a synthetic package; its export shows `assembledFrom` and the cost once.
2. A reference cleared only for provider input blocks export (`RIGHTS_INCOMPLETE`).
3. The export verify endpoint reports `complete`; replacing the file reports `incomplete`.
4. A request without a session for an export file returns 401.

## B. Paid generation (Higgsfield proposed; not entitled or priced)

**Unlocks:** real image and video generation through the durable job ledger.

**Proposed configuration:**

| Variable | Meaning |
| --- | --- |
| `LIVE_PROVIDER_CALLS=enabled` | Master switch. Off: no provider call is ever made. |
| Provider and model | An approved adapter must exist for the chosen provider. No silent substitution: an unavailable provider is refused, never replaced. |
| `PRICE_VERSION`, `PRICE_CURRENCY` | The approved price table version and its currency. Missing prices block paid work. |
| `SPEND_CAP_TIMEZONE` | The IANA zone for daily and monthly caps. |
| Caps | Per-job, daily and monthly caps, in minor units. |

**Owner evidence needed:**
- API entitlement and terms;
- model list;
- commercial-use and image rights;
- the price sheet;
- the caps.

**Note:** keys already present on the api service (`FAL_KEY`, `HIGGSFIELD_*`, `KLING_*`, `LEONARDO_API_KEY`) are **not** permission. A configured secret is not an approval.

**Rollback:** turn the generation switch on the Operations screen to paused, or unset `LIVE_PROVIDER_CALLS`. Accepted work stays reconcilable, and uncertain money stays reserved.

**Operator acceptance:**
1. One synthetic-content job within a tiny cap.
2. Exact reservation, settlement and application records.
3. A forced timeout shows "outcome unknown", not "failed", and is never bought twice.

## C. Publishing (outside the first release)

**Unlocks:** posting to platform accounts. The current release ends at private export, so this is not proposed for activation now.

**Configuration:** `LIVE_PUBLISHING`, `APPROVED_PUBLISH_DESTINATIONS`, `PUBLISH_ACCOUNTS`, plus a real publisher adapter. Only simulation exists.

**Owner evidence needed:**
- official API access and scopes per platform;
- account ownership;
- the disclosure policy.

## D. Editor and reviewer invites

**Unlocks:** the owner issuing single-use, expiring codes for editors and reviewers (ADR 0001 addendum).

**Configuration:** `ROLE_INVITES=enabled`.

**Resources:** none beyond the existing database.

**Rollback:** unset it. New invites are refused, existing sessions keep working until they expire, and Revoke still works.

**Operator acceptance:**
1. Issue a reviewer invite in Operations, then Team access.
2. Sign in with it in a private window.
3. Confirm owner Operations is denied.
4. Revoke it, and confirm that window is signed out.

## E. Analytics

**Unlocks:** API readings from platforms. Manual readings with a source already work, and an absent adapter leaves metrics unknown.

**Configuration:** `METRICS_API=enabled` plus an implemented provider. None exists yet.

**Owner evidence needed:** platform analytics access and its terms.

---

## Not to be touched without billing evidence and approval

Railway shows **seven** Postgres services. The API uses **Postgres**, identified by its private endpoint `postgres` as named in the API's migration logs. The other six (`Postgres-aKPf`, `-0Vjd`, `-uBM6`, `-jpvm`, `--Vsj`, `-KO8i`) are not referenced by the API. That alone does not prove they are unused elsewhere, or what they cost. Do not delete them or remove volumes without a billing check and explicit approval.
