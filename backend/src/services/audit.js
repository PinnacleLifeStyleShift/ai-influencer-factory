/**
 * Audit trail.
 *
 * WHY after-the-fact and best effort: the event is written when the response
 * finishes, so the recorded status is the real outcome; a failed audit write
 * is logged but never turns a completed action into an error. This is
 * operator evidence, not a tamper-proof ledger (a database admin can edit it).
 *
 * Redaction rule: only the route pattern, target id, status, error code,
 * actor and correlation id are stored. Request bodies, query strings,
 * headers, tokens and provider payloads are never recorded.
 */
const TARGET_TYPES = [
  [/^\/api\/characters\/:id/, "character"],
  [/^\/api\/pipeline\/:id/, "pipeline_item"],
  [/^\/api\/content\/:id/, "content"],
  [/^\/api\/campaigns\/:id/, "campaign"],
];

/**
 * For requests refused before reaching a route (no route pattern yet), replace
 * id-like path segments so raw ids never land in the action text.
 */
export function normalizePath(path) {
  return path.split("/").map((seg) => (/^[A-Za-z0-9_-]{16,}$/.test(seg) || /\d/.test(seg) ? ":id" : seg)).join("/");
}

export function outcomeFor(status) {
  if (status < 400) return "success";
  if (status === 401 || status === 403) return "denied";
  return "failed";
}

export function createAuditLog(prisma, { log = console } = {}) {
  async function record(event) {
    try {
      await prisma.auditEvent.create({ data: event });
    } catch (err) {
      log.error?.(`[audit] write failed for ${event.action} [${event.requestId || "-"}]: ${err?.message}`);
    }
  }

  /** Middleware: records every non-GET API request once its response finishes. */
  function middleware() {
    return (req, res, next) => {
      if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
      res.on("finish", () => {
        // Route pattern (":id"), never the raw path, so ids appear only in targetId.
        const pattern = req.route ? `${req.baseUrl}${req.route.path}` : normalizePath(`${req.baseUrl}${req.path}`);
        const targetType = TARGET_TYPES.find(([re]) => re.test(pattern))?.[1] || null;
        const targetId = typeof req.params?.id === "string" ? req.params.id
          : typeof req.body?.pipelineItemId === "string" ? req.body.pipelineItemId : null;
        record({
          actorId: req.principal?.id || null,
          actorRole: req.principal?.role || null,
          sessionId: req.principal?.sessionId || null,
          action: `${req.method} ${pattern}`,
          targetType: targetType || (req.body?.pipelineItemId ? "pipeline_item" : null),
          targetId: targetId ? String(targetId).slice(0, 64) : null,
          status: res.statusCode,
          outcome: outcomeFor(res.statusCode),
          errorCode: res.locals?.errorCode || null,
          requestId: req.requestId || null,
        });
      });
      return next();
    };
  }

  return { record, middleware };
}
