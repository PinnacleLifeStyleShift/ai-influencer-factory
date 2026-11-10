import express from "express";
import { allow } from "../auth/permissions.js";

/**
 * A router whose every route carries its permission declaration.
 *
 *   r.get(path, handler)                      -> needs ["read"]
 *   r.get(path, ["admin"], handler)           -> explicit
 *   r.post(path, ["generate", "spend"], h)    -> mutations MUST declare
 *   r.post(path, handler)                     -> throws at startup
 *
 * WHY also caseSensitive + strict: "/GENERATE-IMAGE" or "/generate-image/"
 * then simply do not match any route (404), so there is exactly one URL per
 * operation; the declaration is the primary control, this removes the
 * ambiguity around it.
 */
export function secureRouter() {
  const router = express.Router({ caseSensitive: true, strict: true });
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const register = router[method].bind(router);
    router[method] = (path, ...rest) => {
      let needs;
      if (Array.isArray(rest[0])) needs = rest.shift();
      else if (method === "get") needs = ["read"];
      else throw new Error(`Route ${method.toUpperCase()} ${path} has no permission declaration`);
      if (!rest.length) throw new Error(`Route ${method.toUpperCase()} ${path} has no handler`);
      return register(path, allow(needs), ...rest);
    };
  }
  // router.all / router.route stay usable internally by Express; the route
  // coverage test (auth-route-matrix) fails if any route lacks a declaration.
  return router;
}
