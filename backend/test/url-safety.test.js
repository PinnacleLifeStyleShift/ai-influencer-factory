import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExternalUrl, assertResolvesPublic, isPrivateAddress } from "../src/lib/urlSafety.js";

test("syntax check refuses non-https, credentials, ports, local names and private IPs", () => {
  const bad = [
    "http://example.com/a.png", "ftp://example.com/a", "file:///etc/passwd", "javascript:alert(1)",
    "https://user:pw@example.com/a.png", "https://example.com:8443/a.png",
    "https://localhost/a.png", "https://printer.local/a", "https://metadata.internal/x", "https://intranet/x",
    "https://127.0.0.1/a", "https://10.1.2.3/a", "https://172.16.0.1/a", "https://192.168.1.1/a",
    "https://169.254.169.254/latest/meta-data", "https://100.64.0.1/a", "https://0.0.0.0/a",
    "https://[::1]/a", "https://[fd00::1]/a", "https://[fe80::1]/a", "https://[::ffff:127.0.0.1]/a", "https://[::ffff:7f00:1]/a", "https://[::ffff:a9fe:a9fe]/a", "https://[::127.0.0.1]/a",
    "not a url", "",
  ];
  for (const u of bad) assert.equal(checkExternalUrl(u).ok, false, u);
  for (const u of ["https://example.test/a.png", "https://cdn.example.com:443/x.mp4", "https://93.184.216.34/a.png"]) {
    assert.equal(checkExternalUrl(u).ok, true, u);
  }
});

test("DNS check refuses public-looking names that resolve to private addresses", async () => {
  const lookup = async (host) => (host === "rebind.example.com"
    ? [{ address: "93.184.216.34" }, { address: "10.0.0.5" }]
    : [{ address: "93.184.216.34" }]);
  await assert.rejects(assertResolvesPublic("https://rebind.example.com/a.png", { lookup }), /private/);
  assert.equal(await assertResolvesPublic("https://cdn.example.com/a.png", { lookup }), "https://cdn.example.com/a.png");
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});
