import crypto from "crypto";
import { DESTINATIONS } from "../lib/revision.js";

/**
 * Publisher adapters: one per destination platform.
 *
 * Contract (what a real adapter must implement before it can be enabled):
 *   platform, implemented: true, simulated: false,
 *   capabilities: { idempotencyKey: bool, statusLookup: bool },
 *   publish(payload, ctx) -> { status: "published" | "processing", remotePostId?, permalink?, remoteRequestId? }
 *     ctx.clientRef        stable per delivery attempt; send it as the
 *                          platform's idempotency key where supported
 *     ctx.onAccepted(id)   call as soon as the platform accepts the request
 *     Throw an error with `notSubmitted = true` ONLY when the request provably
 *     never reached the platform (local validation, refused before sending).
 *     Every other failure is treated as "outcome unknown".
 *   lookup({ clientRef, remoteRequestId }) -> { status: "published" | "processing" | "not_found" | "failed", remotePostId?, permalink? }
 *
 * WHY no real adapter exists: posting needs an approved account, verified
 * official API eligibility and scopes. Until those are decided the real
 * platforms are listed as not implemented, so nothing can be posted.
 */
export class PublishRejected extends Error {
  constructor(message, code = "PUBLISH_REJECTED") { super(message); this.code = code; this.notSubmitted = true; }
}

const notImplemented = (platform) => ({
  platform, implemented: false, simulated: false, capabilities: {},
  reason: `No ${platform} publisher is implemented; it needs an approved account and verified official API access`,
});

/**
 * A simulated publisher: records what would have been sent and answers with
 * clearly fake identifiers. Results are labelled simulated everywhere and
 * never mark content as published.
 */
export function createSimulatedPublisher(platform) {
  const sent = new Map();
  return {
    platform, implemented: true, simulated: true,
    capabilities: { idempotencyKey: true, statusLookup: true },
    async publish(payload, ctx) {
      const id = `sim-${platform.toLowerCase()}-${crypto.createHash("sha256").update(ctx.clientRef).digest("hex").slice(0, 12)}`;
      await ctx.onAccepted?.(id);
      const result = { status: "published", remotePostId: id, permalink: `https://example.test/simulated/${platform.toLowerCase()}/${id}`, remoteRequestId: id };
      sent.set(ctx.clientRef, result);
      return result;
    },
    async lookup({ clientRef }) { return sent.get(clientRef) || { status: "not_found" }; },
  };
}

/** Default registry: real platforms are not implemented; simulation is opt-in. */
export function defaultPublishers(env = process.env) {
  return Object.fromEntries(DESTINATIONS.map((p) => [p, env.PUBLISHING_SIMULATION === "enabled" ? createSimulatedPublisher(p) : notImplemented(p)]));
}
