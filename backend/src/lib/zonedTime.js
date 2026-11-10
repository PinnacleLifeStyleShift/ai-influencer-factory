
/**
 * Wall-clock time in an IANA zone <-> UTC instant.
 *
 * WHY explicit handling: a destination schedule is "9:00 in Los Angeles", but
 * twice a year that wall time either happens twice (clocks go back) or never
 * (clocks go forward). Guessing would silently move a post by an hour, so an
 * ambiguous time needs an explicit choice and a nonexistent time is refused.
 * We store the zone, the wall time and the resolved UTC instant.
 */
// Canonical IANA names only (e.g. America/Los_Angeles) plus UTC. WHY: legacy
// abbreviations such as "PST" or "EST" are accepted by Intl but are ambiguous
// to people and some ignore daylight saving, so they are refused.
const ZONES = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);
export const isScheduleZone = (z) => typeof z === "string" && ZONES.has(z);

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Offset of `zone` from UTC at instant `ms`, in minutes (e.g. -420 for PDT). */
export function offsetMinutes(ms, zone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName").value; // "GMT-07:00" or "GMT"
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/** "YYYY-MM-DDTHH:mm" wall time of instant `ms` in `zone`. */
export function localOf(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/**
 * Resolves a wall time in a zone.
 * Returns { status: "ok" | "ambiguous" | "nonexistent" | "invalid", instants: Date[] }.
 * For "ambiguous", instants are [earlier, later].
 */
export function resolveLocal(local, zone) {
  const m = LOCAL_RE.exec(local || "");
  if (!m || !isScheduleZone(zone)) return { status: "invalid", instants: [] };
  const [, y, mo, d, h, mi] = m.map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  if (Number.isNaN(naive) || new Date(naive).getUTCDate() !== d || h > 23 || mi > 59) return { status: "invalid", instants: [] };
  // Every offset the zone uses within a day either side covers any transition.
  const offsets = new Set([-36, -24, -12, 0, 12, 24, 36].map((hrs) => offsetMinutes(naive + hrs * 3600_000, zone)));
  const instants = [...new Set([...offsets].map((o) => naive - o * 60_000))]
    .filter((t) => localOf(t, zone) === local)
    .sort((a, b) => a - b)
    .map((t) => new Date(t));
  if (instants.length === 0) return { status: "nonexistent", instants };
  if (instants.length > 1) return { status: "ambiguous", instants };
  return { status: "ok", instants };
}

/** UTC offset label for display, e.g. "UTC-07:00". */
export function offsetLabel(ms, zone) {
  const o = offsetMinutes(ms, zone);
  const a = Math.abs(o);
  return `UTC${o < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
