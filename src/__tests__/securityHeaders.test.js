import { describe, it, expect } from "vitest";
import { securityHeaders, serveConfig } from "../securityHeaders.js";

describe("frontend security headers", () => {
  it("allow scripts only from the app and calls only to its own API", () => {
    const h = securityHeaders("https://api.example.test/some/path");
    const csp = h["Content-Security-Policy"];
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("connect-src 'self' https://api.example.test;");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("no-referrer");
  });
  it("without an API URL, the app may call nothing but itself", () => {
    expect(securityHeaders("")["Content-Security-Policy"]).toContain("connect-src 'self';");
  });
  it("serve.json applies headers to every path and does not cache index.html", () => {
    const c = serveConfig("https://api.example.test");
    expect(c.headers[0].source).toBe("**/*");
    expect(c.headers[0].headers.map((x) => x.key)).toContain("Content-Security-Policy");
    expect(c.headers[1]).toEqual({ source: "index.html", headers: [{ key: "Cache-Control", value: "no-cache" }] });
  });
});
