# ADR 0006: Schedule bound to approval, cancellation fencing, verified export

Status: accepted (reversible). Date: 2026-11-10.

## Schedule is part of what is approved

- **Stored on the item:** the destination's IANA zone (`scheduleTimezone`), the wall time there (`scheduleLocal`, `YYYY-MM-DDTHH:mm`) and the resolved UTC instant (`scheduledAt`).
- **In the approval:** `scheduledAt` and `scheduleTimezone` are in the approval snapshot hash. They are added only when set, so items without a schedule keep their earlier hash.
- **Changing the time needs a new approval:** this is the simpler, version-bound approach the brief asked for. There is no separate "reschedule" permission. `PATCH /api/pipeline/:id { schedule }` clears approval like any other change.
- **Scheduling takes no input:** `POST /:id/schedule` puts the approved instant on the calendar. It refuses:
  - no time set: `SCHEDULE_TIME_REQUIRED`;
  - a different date: `SCHEDULE_NOT_APPROVED`;
  - a time already passed: `SCHEDULE_IN_PAST`;
  - a different destination: `DESTINATION_MISMATCH`.
- **Calendar rows from an approval are locked:** title, platform, caption, hashtags and date can only change through the pipeline item.
- **The calendar is a plan.** Nothing marks content published (`PUBLISHING_NOT_ENABLED`, unchanged).

## Time zones and daylight saving

- **Canonical names only:** IANA names (for example `America/Los_Angeles`) plus `UTC`. Abbreviations such as `PST`/`EST` and legacy aliases are refused, because they are ambiguous to people.
- **A wall time that happens twice** (clocks go back) returns `SCHEDULE_TIME_AMBIGUOUS` with both options (UTC and offset). The operator must choose `earlier` or `later`.
- **A wall time that never happens** (clocks go forward) returns `SCHEDULE_TIME_NONEXISTENT`.
- **Implementation:** offsets come from `Intl`; there is no time zone library. Tested for Los Angeles, London and Lord Howe Island (a 30-minute shift).
- **On review the screen shows:** the destination time with its zone and offset, the UTC instant, and the viewer's own time when it differs.

## Cancellation fences delivery

- **`POST /:id/cancel-schedule { reason }`** (permission `schedule`) does two things in one transaction:
  - marks the calendar row `cancelled` (who, when, why);
  - moves the item back to review with a new revision, which clears approval.
- **Other paths are closed:** the calendar's own routes cannot cancel or delete an approved schedule (`USE_CANCEL_SCHEDULE`), and a scheduled item cannot be deleted.
- **`assertDeliverable(contentId)`** in `services/calendar.js` is the fence every future delivery job must pass. The entry must be:
  - scheduled and not cancelled;
  - created from an approval;
  - still exactly the item's current approved snapshot.

## Export

- **`POST /:id/exports`** (permission `export`: owner and editor; reviewers can read exports but not create them) works only for the **current** approved snapshot. It is checked again after the slow media reads.
- **Every file is read and checked on its bytes:**
  - type from magic bytes;
  - dimensions;
  - for video: a movie header with a positive duration, a video track, and a complete box structure whose sample data lies inside the file;
  - aspect ratio against the export settings;
  - the recorded clip length against the file.
- **Any failure returns `EXPORT_MEDIA_INVALID`:** the screen shows the problems per file, records nothing and shows no success badge.
- **Limits of the video check:** it is a container check, not a full decode. It catches broken links, truncation and mislabelled files, not every codec-level corruption.
- **The manifest is an allow-list:**
  - approval, destination and planned time ("planned only");
  - caption, hashtags, disclosure, export settings;
  - character version, script version and evidence;
  - per file: MIME, bytes, sha256, dimensions, duration, provider:model, inputs (version, conditioning, reference fingerprints) and cost (actual when settled, otherwise its state);
  - rights of the references actually sent.
- **Left out:** prompts, provider request ids, reservation ids, notes and logs, credentials, and the reference images themselves.
- **Deterministic:** the manifest has no export time and is serialised canonically. The same approved content gives the same manifest hash, and a repeat export returns the existing record.
- **Superseded exports:** after any change, an older export is listed and downloaded marked as superseded (`X-Export-Current: false`, "SUPERSEDED" in the readable version).
- **Rights:** every reference that was sent needs an approved, unexpired rights record that permits `publication` (`RIGHTS_INCOMPLETE` otherwise).
- **Downloads:** JSON or readable text, as an attachment. Export never posts and never contacts anyone.

## Media storage

- **Default `MEDIA_STORE` is disabled.** Nothing is downloaded from provider URLs, and export answers `MEDIA_STORE_NOT_CONFIGURED`. Private object storage is an approved resource with a cost.
- **`MEDIA_STORE=synthetic-fixture` with `MEDIA_FIXTURE_DIR`** serves local files only, and only for the reserved `example.test` domain. It is used by tests and the browser check.
- **`POST /:id/measure-media`** replaces each shot clip's recorded length with the length measured from the file (`durationSource: "measured"`). This closes Package C's "measure real media" gap wherever storage exists, and it clears approval.

## Not done here

- **Media in the export:** the bytes are not bundled into one archive. The manifest lists each file's URL and sha256; bundling needs storage.
- **Real storage:** a real object store and its retention policy (an owner decision).
- **Publishing:** later work, section 10. `assertDeliverable` is ready for it.
