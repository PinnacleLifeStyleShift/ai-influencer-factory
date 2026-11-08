import crypto from "crypto";
import { ApiError, sendError } from "../lib/errors.js";

/**
 * Interim single-owner authentication (spec WP2, one owner role).
 *
 * Every /api request must present `Authorization: Bearer <OWNER_API_TOKEN>`.
 * Fails closed: if OWNER_API_TOKEN is unset or too short, every protected
 * request is refused with AUTH_NOT_CONFIGURED. The token lives only in the
 * server environment; it is never placed in the frontend bundle.
 *
 * This is a placeholder for the owner-selected authentication approach
 * (accounts/sessions/SSO), which remains an open decision.
 */
export const MIN_TOKEN_LENGTH = 32;

function digest(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest();
}

export function requireOwnerToken(env = process.env) {
  return (req, res, next) => {
    const configured = env.OWNER_API_TOKEN;
    if (!configured || configured.length < MIN_TOKEN_LENGTH) {
      return sendError(
        res,
        new ApiError("AUTH_NOT_CONFIGURED", 503, "API authentication is not configured on the server")
      );
    }

    const header = req.get("authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return sendError(res, new ApiError("AUTH_REQUIRED", 401, "Authentication required"));
    }

    // Compare fixed-length digests so timing does not leak token length/content.
    if (!crypto.timingSafeEqual(digest(match[1].trim()), digest(configured))) {
      return sendError(res, new ApiError("AUTH_REQUIRED", 401, "Authentication required"));
    }

    req.principal = { role: "owner" };
    return next();
  };
}
