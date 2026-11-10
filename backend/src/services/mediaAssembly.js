import { spawn, spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";

/**
 * Deterministic local assembly of a multi-shot package into one video.
 *
 * WHY these choices:
 *  - Explicit opt-in (MEDIA_ASSEMBLY=ffmpeg) and a real capability check: an
 *    image without ffmpeg (the production images today) reports
 *    ASSEMBLY_UNAVAILABLE instead of pretending.
 *  - Deterministic output: fixed size and frame rate, single-threaded x264,
 *    bit-exact flags and no metadata, so the same approved inputs give the
 *    same bytes and the same hash.
 *  - Each clip is trimmed to its planned shot length (the plan decides the
 *    timing; clips are usually generated as 5 s or 10 s).
 *  - A full decode of the result ("plays end to end"), not just a header read.
 *  - Bounded: a time limit per run; inputs are size-limited by the store.
 * Not done here: audio (synthetic clips are silent) and burned-in captions.
 */
export const ASSEMBLY_TIMEOUT_MS = 60_000;
const SIZES = { "9:16": [1080, 1920], "1:1": [1080, 1080], "16:9": [1920, 1080] };

let probed = null;
function ffmpegVersion() {
  if (probed !== null) return probed;
  const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  probed = r.status === 0 ? (r.stdout.split("\n")[0].match(/ffmpeg version (\S+)/)?.[1] || "unknown") : "";
  return probed;
}

export function assemblyCapability(env = process.env) {
  if (env.MEDIA_ASSEMBLY !== "ffmpeg") return { available: false, reason: "MEDIA_ASSEMBLY is not enabled" };
  const v = ffmpegVersion();
  if (!v) return { available: false, reason: "ffmpeg is not installed on this server" };
  return { available: true, tool: `ffmpeg ${v}` };
}

function run(args, { timeoutMs }) {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { if (stderr.length < 4000) stderr += d; });
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (code, signal) => { clearTimeout(t); resolve({ code, signal, stderr }); });
  });
}

/**
 * clips: [{ bytes, trimSec }] in shot order. Returns { bytes, sha256, tool }.
 * Throws an Error with .code ASSEMBLY_FAILED / ASSEMBLY_TIMEOUT / ASSEMBLY_DECODE_FAILED.
 */
export async function assemble(clips, { aspectRatio = "9:16", fps = 30, timeoutMs = ASSEMBLY_TIMEOUT_MS, tool = "ffmpeg" } = {}) {
  const [w, h] = SIZES[aspectRatio] || SIZES["9:16"];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aif-assembly-"));
  const fail = (code, message) => Object.assign(new Error(message), { code });
  try {
    const inputs = [];
    for (let i = 0; i < clips.length; i++) {
      const f = path.join(dir, `in${i}.mp4`);
      await fs.writeFile(f, clips[i].bytes);
      inputs.push("-i", f);
    }
    const chains = clips.map((c, i) => `[${i}:v]trim=duration=${c.trimSec.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`);
    const filter = `${chains.join(";")};${clips.map((_, i) => `[v${i}]`).join("")}concat=n=${clips.length}:v=1:a=0[out]`;
    const out = path.join(dir, "out.mp4");
    const args = ["-v", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[out]", "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-threads", "1", "-x264-params", "threads=1:sliced-threads=0",
      "-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1", "-movflags", "+faststart", out];
    const r = await run(args, { timeoutMs });
    if (r.signal === "SIGKILL") throw fail("ASSEMBLY_TIMEOUT", `Assembly took longer than ${Math.round(timeoutMs / 1000)} s`);
    if (r.code !== 0) throw fail("ASSEMBLY_FAILED", `ffmpeg could not assemble the clips: ${r.stderr.split("\n")[0].slice(0, 200)}`);
    // Plays end to end: decode every frame.
    const d = await run(["-v", "error", "-i", out, "-f", "null", "-"], { timeoutMs });
    if (d.code !== 0 || d.stderr.trim()) throw fail("ASSEMBLY_DECODE_FAILED", "The assembled file does not decode cleanly");
    const bytes = await fs.readFile(out);
    return { bytes, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), tool, size: [w, h] };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
