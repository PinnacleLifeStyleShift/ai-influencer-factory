/**
 * Security headers for the static frontend (written to dist/serve.json at
 * build time and applied by `serve`).
 *
 * WHY each directive:
 *  - script-src 'self': only the bundled code runs (no inline or third-party scripts)
 *  - connect-src: the app may only call its own API (VITE_API_URL)
 *  - img-src / media-src https: generated media comes from provider/CDN URLs
 *  - style-src 'unsafe-inline' + Google Fonts: React style attributes and the
 *    font stylesheet; styles cannot run code
 *  - frame-ancestors 'none' + X-Frame-Options: the app cannot be framed (clickjacking)
 *  - Referrer-Policy no-referrer: URLs never leak to the media hosts
 */
export function securityHeaders(apiUrl) {
  let apiOrigin = "";
  try { apiOrigin = new URL(apiUrl).origin; } catch { /* no API configured: the build fails earlier */ }
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ""}`,
    "img-src 'self' https: data: blob:",
    "media-src 'self' https: blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
}

/** serve.json for `serve`: security headers on every path; index.html never cached. */
export function serveConfig(apiUrl) {
  const headers = Object.entries(securityHeaders(apiUrl)).map(([key, value]) => ({ key, value }));
  return {
    headers: [
      { source: "**/*", headers },
      { source: "index.html", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ],
  };
}
