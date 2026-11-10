import net from "net";
import dns from "dns";

/**
 * External asset URL checks (SSRF defence).
 *
 * WHY: reference images and provider results are URLs that a server-side
 * adapter may later fetch or forward. A URL pointing at localhost, a private
 * network or cloud metadata (169.254.169.254) would let a request reach
 * internal services. Two layers:
 *  - checkExternalUrl: syntax-level, applied when a URL is accepted or stored
 *  - assertResolvesPublic: DNS-level, for the moment a server fetch happens
 *    (a public-looking name can resolve to a private address)
 * Redirects must be re-checked at every hop by whatever performs a fetch.
 */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

function ipv4Private(ip) {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function ipv6Private(ip) {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  // IPv4-mapped addresses, in dotted form or the hex form URL parsing produces
  // (new URL("https://[::ffff:127.0.0.1]").hostname === "[::ffff:7f00:1]").
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return ipv4Private(mapped[1]);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // Deprecated IPv4-compatible range ::/96, dotted or hex ("[::127.0.0.1]"
  // parses to "[::7f00:1]"): never a legitimate public asset host.
  if (/^::(\d+\.\d+\.\d+\.\d+)$/.test(v) || /^::[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v)) return true;
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v.replace(/^\[|\]$/g, ""));
}

export function isPrivateAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4Private(ip);
  if (kind === 6) return ipv6Private(ip);
  return true; // not an IP: callers only pass resolved addresses
}

/** Returns { ok: true, url } or { ok: false, reason }. */
export function checkExternalUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, reason: "not a valid URL" }; }
  if (u.protocol !== "https:") return { ok: false, reason: "only https URLs are allowed" };
  if (u.username || u.password) return { ok: false, reason: "URLs with credentials are not allowed" };
  if (u.port && u.port !== "443") return { ok: false, reason: "non-standard ports are not allowed" };
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "local hostnames are not allowed" };
  }
  if (net.isIP(host) && isPrivateAddress(host)) return { ok: false, reason: "private or reserved addresses are not allowed" };
  if (!net.isIP(host) && !host.includes(".")) return { ok: false, reason: "single-label hostnames are not allowed" };
  return { ok: true, url: u.toString() };
}

/** DNS-level check, for use immediately before a server-side fetch. */
export async function assertResolvesPublic(raw, { lookup = dns.promises.lookup } = {}) {
  const syntax = checkExternalUrl(raw);
  if (!syntax.ok) throw new Error(`Unsafe URL: ${syntax.reason}`);
  const host = new URL(syntax.url).hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error("Unsafe URL: resolves to a private or reserved address");
  }
  return syntax.url;
}
