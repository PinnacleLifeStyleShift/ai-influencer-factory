/**
 * Claims check for scripts.
 *
 * WHY: a synthetic persona must not present invented facts or invented life
 * experience as real. Two kinds of lines are flagged:
 *  - factual claims (numbers, studies, guarantees, health/money promises):
 *    each needs an evidence entry with a source URL, or must be removed;
 *  - first-person experience ("I tried", "my clients", "changed my life"):
 *    allowed only as fiction, i.e. with a synthetic-persona disclosure on
 *    the package, or backed by a source-type evidence entry.
 * A pattern scan cannot find every claim; it is a floor, and the operator
 * review rubric still applies. It never approves anything by itself.
 */
const FACTUAL = [
  /\b\d+(\.\d+)?\s?%/i, /\bstud(y|ies)\b/i, /\bresearch\b/i, /\bscientific(ally)?\b/i, /\bclinical(ly)?\b/i,
  /\bproven\b/i, /\bguarantee[ds]?\b/i, /\bcures?\b/i, /\bdoctors?\b/i, /\bexperts? (say|agree)\b/i,
  /\$\s?\d/, /\b(lose|lost|drop(ped)?)\s+\d+\s*(lbs?|pounds|kg|kilos)\b/i, /\b\d+x\b/i, /\b(earn|make|made)\s+\$?\d/i,
];
const EXPERIENCE = [
  /\bI (tried|tested|used|went|visited|travel(l)?ed|lost|gained|earned|made|built|struggled|discovered|learned)\b/i,
  /\bhappened to me\b/i, /\bchanged my (life|perspective)\b/i, /\bmy (clients|customers|students|results)\b/i,
  /\bI can't believe this actually happened\b/i, /\bfrom struggling to thriving\b/i, /\bI wish I knew\b/i,
];

const sentencesOf = (text) => (text || "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

export function scanClaims({ hook, body, callToAction }) {
  const out = [];
  for (const [part, text] of [["hook", hook], ["body", body], ["callToAction", callToAction]]) {
    for (const s of sentencesOf(text)) {
      if (FACTUAL.some((re) => re.test(s))) out.push({ part, text: s, kind: "factual" });
      else if (EXPERIENCE.some((re) => re.test(s))) out.push({ part, text: s, kind: "experience" });
    }
  }
  return out;
}

const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
const covers = (entry, text) => {
  const a = norm(entry.claim); const b = norm(text);
  return a.length >= 8 && (b.includes(a) || a.includes(b));
};

/**
 * Returns { ok, unsupported: [{ text, kind, need }] }.
 * disclosure: the package's synthetic-persona disclosure (fiction framing).
 */
export function checkClaims(scriptFields, evidence = [], disclosure = "") {
  const fictionDisclosed = /\b(fictional|synthetic|ai[- ]generated|virtual)\b/i.test(disclosure || "");
  const unsupported = [];
  for (const c of scanClaims(scriptFields)) {
    const sourced = evidence.some((e) => e.basis === "source" && e.sourceUrl && covers(e, c.text));
    if (c.kind === "factual" && !sourced) unsupported.push({ ...c, need: "a source (evidence entry with a URL) or removal" });
    if (c.kind === "experience" && !sourced && !fictionDisclosed) {
      unsupported.push({ ...c, need: "a synthetic-persona disclosure (fiction framing) or a source" });
    }
  }
  return { ok: unsupported.length === 0, unsupported, fictionDisclosed };
}
