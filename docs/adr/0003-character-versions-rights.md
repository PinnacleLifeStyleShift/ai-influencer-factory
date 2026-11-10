# ADR 0003: Character versions, reference rights and recorded inputs

Status: accepted (reversible). Date: 2026-11-09.

## Versions

- **The `characters` row is the single editable draft.** The existing editor and routes keep working.
- **Publishing** (`POST /api/characters/:id/versions`) freezes it into an immutable `character_versions` row:
  - `identity`: name, type, niche, persona, appearance. This must stay recognisably the same.
  - `styling`: aspect ratio, quality, B-O-P-A, optional prompt, platforms. This may vary per shot.
  - `references`: the current reference image, pinned by id and fingerprint.
  - `contentHash`.
- **Publishing is idempotent:** if nothing changed, the latest version is returned. Concurrent publishes are safe (a unique `(character, version)` index, with retry).
- **Restore** copies a version back into the draft; published versions never change.
- *Alternative not taken:* a separate draft table. It would have meant rewriting the editor and legacy routes now, for no extra safety.

## Pinning

- New pipeline items pin the character's published version at script time. A legacy item is pinned on its first generation, which publishes v1 if the character has none.
- Generation builds its prompt from the **pinned version**, never the live draft. So editing a character or publishing v2 cannot change what older items are made from.
- `characterVersionId` is part of the approval snapshot hash: changing an item's version invalidates its approval.

## References and rights

- **References are tracked assets** (`character_images`), each with a `fingerprint`: a sha256 of its URL. The byte `checksum` stays empty until media is actually stored (private storage needs approval).
  - **Limitation:** a fingerprint identifies a URL, not the bytes behind it.
- **Changing the reference:** the reference URL can no longer be edited in place (`USE_REFERENCE_WORKFLOW`). Add the image, then promote it, confirming replacement. The old reference stays in history.
- **Rights are append-only `rights_records`:**
  - Each record has a basis, holder, permitted uses (`provider_input`, `publication`, `training`), whether it is a real person's likeness, a consent reference (required for a likeness), a license reference (required for licensed material) and an optional expiry.
  - **The owner approves the exact record they reviewed** (`RIGHTS_STALE` otherwise).
  - **An image may reach a provider only when the newest record is approved, permits `provider_input`, is unexpired and has consent where needed.** The gallery shows exactly what is missing.
- **Generated images also start with no rights,** because the provider's commercial terms are an open owner decision.

## Capabilities and recorded inputs

- **Adapters declare capabilities:**
  - `referenceConditioning`: reference images are sent to steer identity.
  - `sourceImage`: an input image is animated.
  - The recovered Higgsfield and Leonardo calls declare neither; fal/Kling declare `sourceImage`.
- **Asking for a capability the selected adapter lacks is refused before any claim or spend:**
  - `referenceMode: "required"` on pipeline generation, or `source: "reference"` on character video.
  - The refusal is `REFERENCE_CONDITIONING_UNSUPPORTED`, or `REFERENCE_NOT_CLEARED` with the missing items.
- **Character video defaults to text-to-video.** Previously, any reference was sent automatically.
- **Every result records what was actually used:**
  - Pipeline (`generation_applications`) and candidates (`generation_inputs`): version id (candidates: draft hash), sha256 of the prompt (never the prompt itself), the fingerprints of references sent, and `conditioning` (`none` / `references_sent`).
  - No identity consistency is claimed from a stored-but-unsent reference.

## Not done here

- Real reference conditioning: no approved adapter supports it.
- Stored media with byte checksums.
- Workspace-level isolation.
- A human acceptance pilot on real output (see `docs/review-rubric.md`).
