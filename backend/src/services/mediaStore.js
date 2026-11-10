import fs from "fs/promises";
import path from "path";

/**
 * Where export and assembly read (and assembly writes) media bytes.
 *
 * WHY an interface with a disabled default: retaining media needs private
 * object storage, which is an approved resource with a cost. Until then
 * nothing is downloaded from provider URLs, and export reports
 * MEDIA_STORE_NOT_CONFIGURED instead of claiming success. Tests and local
 * demos use the synthetic fixture store: it serves files from one local
 * directory for URLs on the reserved example.test domain, and keeps rendered
 * files in a separate output directory.
 *
 * Contract:
 *   read(url)  -> { ok: true, bytes } | { ok: false, problem }
 *   write(name, bytes) -> { ok: true, url } | { ok: false, problem }   (optional)
 * Reads larger than MEDIA_MAX_BYTES are refused before loading.
 */
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

export function createMediaStore(env = process.env) {
  if (env.MEDIA_STORE === "synthetic-fixture" && env.MEDIA_FIXTURE_DIR) {
    return createFixtureMediaStore(env.MEDIA_FIXTURE_DIR, { outputDir: env.MEDIA_OUTPUT_DIR, maxBytes: Number(env.MEDIA_MAX_BYTES) || DEFAULT_MAX_BYTES });
  }
  return { kind: "disabled", configured: false, writable: false, async read() { return { ok: false, problem: "MEDIA_STORE_NOT_CONFIGURED" }; } };
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export function createFixtureMediaStore(dir, { outputDir = null, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const root = path.resolve(dir);
  const out = outputDir ? path.resolve(outputDir) : null;
  return {
    kind: "synthetic-fixture",
    configured: true,
    writable: Boolean(out),
    async read(url) {
      let u;
      try { u = new URL(url); } catch { return { ok: false, problem: "invalid URL" }; }
      if (u.protocol !== "https:" || u.hostname !== "example.test") return { ok: false, problem: "not in the synthetic media store" };
      let name;
      try { name = path.basename(decodeURIComponent(u.pathname)); } catch { return { ok: false, problem: "invalid URL" }; }
      // basename() drops any directory part, so a URL cannot escape the root.
      if (!SAFE_NAME.test(name)) return { ok: false, problem: "invalid file name" };
      for (const base of [out, root].filter(Boolean)) {
        const file = path.join(base, name);
        let st;
        try { st = await fs.stat(file); } catch { continue; }
        if (!st.isFile()) continue;
        if (st.size > maxBytes) return { ok: false, problem: `file is larger than the ${Math.round(maxBytes / 1048576)} MB limit` };
        return { ok: true, bytes: await fs.readFile(file) };
      }
      return { ok: false, problem: "media not found (broken link)" };
    },
    async write(name, bytes) {
      if (!out) return { ok: false, problem: "MEDIA_OUTPUT_NOT_CONFIGURED" };
      if (!SAFE_NAME.test(name)) return { ok: false, problem: "invalid file name" };
      await fs.mkdir(out, { recursive: true });
      await fs.writeFile(path.join(out, name), bytes);
      return { ok: true, url: `https://example.test/${name}` };
    },
  };
}
