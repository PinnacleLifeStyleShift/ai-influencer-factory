import fs from "fs/promises";
import path from "path";

/**
 * Where export reads media bytes from.
 *
 * WHY an interface with a disabled default: retaining media needs private
 * object storage, which is an approved resource with a cost. Until then
 * nothing is downloaded from provider URLs, and export reports
 * MEDIA_STORE_NOT_CONFIGURED instead of claiming success. Tests and local
 * demos use the synthetic fixture store, which serves only files from one
 * local directory for URLs on the reserved example.test domain.
 *
 * Contract: read(url) -> { ok: true, bytes: Buffer } | { ok: false, problem }
 */
export function createMediaStore(env = process.env) {
  if (env.MEDIA_STORE === "synthetic-fixture" && env.MEDIA_FIXTURE_DIR) return createFixtureMediaStore(env.MEDIA_FIXTURE_DIR);
  return { kind: "disabled", configured: false, async read() { return { ok: false, problem: "MEDIA_STORE_NOT_CONFIGURED" }; } };
}

export function createFixtureMediaStore(dir) {
  const root = path.resolve(dir);
  return {
    kind: "synthetic-fixture",
    configured: true,
    async read(url) {
      let u;
      try { u = new URL(url); } catch { return { ok: false, problem: "invalid URL" }; }
      if (u.protocol !== "https:" || u.hostname !== "example.test") return { ok: false, problem: "not in the synthetic media store" };
      const name = path.basename(decodeURIComponent(u.pathname));
      // basename() drops any directory part, so a URL cannot escape the root.
      const file = path.join(root, name);
      try { return { ok: true, bytes: await fs.readFile(file) }; } catch { return { ok: false, problem: "media not found (broken link)" }; }
    },
  };
}
