import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { capabilityMap } from "../src/services/capabilities.js";

/**
 * Capability panel (completion spec, recommendation): one view separating
 * built, configured, switched on and verified, per live capability, so a
 * green build is never read as "live". Names only; never a setting's value.
 */
let net;
before(() => { net = interceptExternalFetch(); });
after(() => { net.restore(); assert.equal(net.calls.length, 0, "no outbound calls"); });

const byKey = (env) => Object.fromEntries(capabilityMap(env).map((c) => [c.key, c]));

test("by default every live capability is off, and the map says what each would need", () => {
  const m = byKey({});
  for (const k of ["generation", "publishing", "mediaStorage", "assembly", "analytics", "roleInvites"]) {
    assert.equal(m[k].enabled, false, k);
    assert.ok(m[k].verifiedBy.length > 0, `${k} names its evidence`);
    assert.ok(m[k].needs.length > 0, `${k} names what it needs`);
  }
  assert.match(m.publishing.built, /simulation/i, "publishing is honest about being simulation-only");
  assert.match(m.mediaStorage.built, /no object storage/i);
  assert.equal(m.multiWorkspace.enabled, false, "multi-tenancy is stated as not offered");
  assert.match(m.multiWorkspace.built, /not an isolation boundary/);
});

test("switched on is not configured: live calls without approved prices stay unconfigured", () => {
  const m = byKey({ LIVE_PROVIDER_CALLS: "enabled" });
  assert.equal(m.generation.enabled, true);
  assert.equal(m.generation.configured, false);
  assert.ok(m.generation.missing.includes("PRICE_VERSION"));
});

test("the map never contains a setting's value, and only the owner can read it", async () => {
  const marker = "SYNTHETIC-SECRET-MARKER-7f3a";
  const env = { OWNER_API_TOKEN: TOKEN, FAL_KEY: marker, HIGGSFIELD_API_KEY: marker, PRICE_VERSION: marker, RETENTION_POLICY: JSON.stringify({ renderedExports: 400 }) };
  assert.ok(!JSON.stringify(capabilityMap(env)).includes(marker));
  const app = await startApp({ env });
  try {
    const r = await app.call("/api/system/capabilities", { token: TOKEN });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(!text.includes(marker), "no values in the response");
    assert.ok(JSON.parse(text).capabilities.some((c) => c.key === "generation"));
    assert.equal((await app.raw("/api/system/capabilities")).status, 401);
  } finally { await app.close(); }
});
