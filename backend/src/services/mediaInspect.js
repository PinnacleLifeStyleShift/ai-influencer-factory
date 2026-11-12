import crypto from "crypto";
import zlib from "zlib";

/**
 * Structural media checks, done on the bytes (never trusting a file name or a
 * provider's claim).
 *
 * WHY: an export manifest promises "this file, with this checksum, is this
 * kind of media, this size and this long". A broken or mislabelled file must
 * stop the success badge. The checks:
 *  - type from magic bytes (PNG, JPEG, MP4/MOV ISO-BMFF)
 *  - dimensions (PNG IHDR, JPEG SOF, MP4 video track header)
 *  - for video: a movie header with a positive duration, a video track, and a
 *    complete box structure whose sample data lies inside the file. This is a
 *    container check, not a full decode; it catches truncation and
 *    mislabelled files, not every codec-level corruption.
 */
const KNOWN = { "image/png": "image", "image/jpeg": "image", "video/mp4": "video", "video/quicktime": "video" };

export function sniffMime(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp") {
    return buf.toString("latin1", 8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  }
  return null;
}

/** Images larger than this are refused before anything decodes them (IF-R3). */
export const MAX_IMAGE_PIXELS = 50_000_000;

/**
 * PNG structure (review IF-R3): every chunk is walked, its length must fit
 * the file and its CRC must match; IHDR must come first, at least one IDAT
 * must carry image data, and IEND must end the file. A header-shaped file
 * with no image data is not an image.
 */
function pngInfo(buf) {
  if (buf.length < 33 || buf.toString("latin1", 12, 16) !== "IHDR") return { problems: ["PNG header is incomplete"] };
  const width = buf.readUInt32BE(16); const height = buf.readUInt32BE(20);
  const problems = [];
  let i = 8; let idatBytes = 0; let ended = false; let first = true;
  while (i < buf.length) {
    if (i + 12 > buf.length) { problems.push("PNG is truncated (incomplete chunk)"); break; }
    const len = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    if (len > buf.length - i - 12) { problems.push(`PNG chunk ${type} is truncated`); break; }
    const crc = buf.readUInt32BE(i + 8 + len);
    if (zlib.crc32(buf.subarray(i + 4, i + 8 + len)) !== crc) { problems.push(`PNG chunk ${type} has an invalid checksum`); break; }
    if (first && type !== "IHDR") { problems.push("PNG does not start with IHDR"); break; }
    first = false;
    if (type === "IDAT") idatBytes += len;
    i += 12 + len;
    if (type === "IEND") { ended = true; break; }
  }
  if (!problems.length) {
    if (!ended) problems.push("PNG is truncated (no end marker)");
    else if (i !== buf.length) problems.push("PNG has data after its end marker");
    if (!idatBytes) problems.push("PNG has no image data");
  }
  if (!width || !height) problems.push("PNG has zero dimensions");
  else if (width * height > MAX_IMAGE_PIXELS) problems.push(`image is larger than ${MAX_IMAGE_PIXELS} pixels`);
  return { width, height, problems };
}

/** JPEG structure: a frame header, scan data and the end marker (IF-R3). */
function jpegInfo(buf) {
  let i = 2; let frame = null;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return { problems: ["JPEG structure is invalid"] };
    const marker = buf[i + 1];
    if (marker === 0xd9) break;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return { problems: ["JPEG is truncated"] };
    if ([0xc0, 0xc1, 0xc2].includes(marker) && i + 9 <= buf.length) frame = { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (marker === 0xda) {
      if (!frame) return { problems: ["JPEG has no frame header"] };
      const problems = [];
      if (i + 2 + len >= buf.length - 2) problems.push("JPEG has no scan data");
      if (!(buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9)) problems.push("JPEG is truncated (no end marker)");
      if (frame.width * frame.height > MAX_IMAGE_PIXELS) problems.push(`image is larger than ${MAX_IMAGE_PIXELS} pixels`);
      return { ...frame, problems };
    }
    i += 2 + len;
  }
  return frame ? { ...frame, problems: ["JPEG has no scan data"] } : { problems: ["JPEG has no frame header"] };
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);

/** Walks ISO-BMFF boxes; returns { boxes: [{type, start, size, body}], problems }. */
function walk(buf, start, end, out, problems, depth = 0) {
  let i = start;
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    let header = 8;
    if (size === 1) { if (i + 16 > end) { problems.push("box header truncated"); return; } size = Number(buf.readBigUInt64BE(i + 8)); header = 16; }
    if (size === 0) size = end - i;
    if (size < header || i + size > end) { problems.push(`'${type}' box runs past the end of the file (truncated)`); return; }
    out.push({ type, start: i, size, body: i + header, depth });
    if (CONTAINERS.has(type) && depth < 8) walk(buf, i + header, i + size, out, problems, depth + 1);
    i += size;
  }
  if (i !== end && depth === 0) problems.push("trailing bytes after the last box");
}

function mp4Info(buf) {
  const boxes = []; const problems = [];
  walk(buf, 0, buf.length, boxes, problems);
  const mvhd = boxes.find((b) => b.type === "mvhd");
  let durationSec = null;
  if (mvhd) {
    const v = buf[mvhd.body];
    const timescale = v === 1 ? buf.readUInt32BE(mvhd.body + 20) : buf.readUInt32BE(mvhd.body + 12);
    const duration = v === 1 ? Number(buf.readBigUInt64BE(mvhd.body + 24)) : buf.readUInt32BE(mvhd.body + 16);
    if (timescale > 0) durationSec = Math.round((duration / timescale) * 1000) / 1000;
  } else problems.push("no movie header (mvhd)");
  // A video track: hdlr 'vide' inside a trak; take its tkhd dimensions.
  let width = null; let height = null;
  const traks = boxes.filter((b) => b.type === "trak");
  for (const t of traks) {
    const inside = boxes.filter((b) => b.start > t.start && b.start < t.start + t.size);
    const hdlr = inside.find((b) => b.type === "hdlr");
    if (!hdlr || buf.toString("latin1", hdlr.body + 8, hdlr.body + 12) !== "vide") continue;
    const tkhd = inside.find((b) => b.type === "tkhd");
    if (tkhd) {
      const off = tkhd.body + (buf[tkhd.body] === 1 ? 88 : 76);
      width = buf.readUInt32BE(off) / 65536; height = buf.readUInt32BE(off + 4) / 65536;
    }
    // Sample data must lie inside the file.
    for (const co of inside.filter((b) => b.type === "stco" || b.type === "co64")) {
      const n = buf.readUInt32BE(co.body + 4);
      for (let k = 0; k < n; k++) {
        const pos = co.type === "stco" ? buf.readUInt32BE(co.body + 8 + k * 4) : Number(buf.readBigUInt64BE(co.body + 8 + k * 8));
        if (pos >= buf.length) { problems.push("sample data points past the end of the file"); break; }
      }
    }
  }
  if (width === null) problems.push("no video track");
  if (!boxes.some((b) => b.type === "mdat")) problems.push("no media data (mdat)");
  if (durationSec !== null && durationSec <= 0) problems.push("duration is zero");
  return { width, height, durationSec, problems };
}

/** Inspects bytes. `expectedKind` is "image" or "video" (what the manifest says it is). */
export function inspectMedia(buf, { expectedKind } = {}) {
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const mime = sniffMime(buf);
  const base = { sha256, bytes: buf.length, mime, width: null, height: null, durationSec: null };
  if (!mime) return { ...base, ok: false, problems: ["not a recognised PNG, JPEG or MP4/MOV file"] };
  const info = mime === "image/png" ? pngInfo(buf) : mime === "image/jpeg" ? jpegInfo(buf) : mp4Info(buf);
  const problems = [...(info.problems || [])];
  if (expectedKind && KNOWN[mime] !== expectedKind) problems.push(`expected ${expectedKind} but the file is ${mime}`);
  if (!(info.width > 0 && info.height > 0)) problems.push("dimensions could not be read");
  return { ...base, width: info.width ?? null, height: info.height ?? null, durationSec: info.durationSec ?? null, ok: problems.length === 0, problems };
}
