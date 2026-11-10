import { ApiError } from "./errors.js";
import { checkExternalUrl } from "./urlSafety.js";

/**
 * Minimal request-body validation for the legacy CRUD routes.
 *
 * WHY hand-rolled: the routes accept both snake_case and camelCase names and
 * map fields themselves; this only checks every supplied value's type, length
 * and allowed values, and refuses the request with all problems listed.
 * Unknown keys are ignored (the routes never copy them).
 *
 * Field spec: { type, max?, min?, values?, required? } where type is one of
 * string | int | decimal | date | enum | enumArray | url.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^\d{1,12}(\.\d{1,2})?$/;

function checkValue(spec, v) {
  if (v === null || v === undefined) return null;
  switch (spec.type) {
    case "string":
      if (typeof v !== "string") return "must be a string";
      if (spec.min && v.trim().length < spec.min) return `must have at least ${spec.min} character(s)`;
      if (v.length > (spec.max ?? 5000)) return `must be at most ${spec.max ?? 5000} characters`;
      return null;
    case "int": {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (!Number.isInteger(n) || n < (spec.min ?? 0) || n > (spec.max ?? 1e12)) return `must be a whole number from ${spec.min ?? 0} to ${spec.max ?? 1e12}`;
      return null;
    }
    case "decimal":
      if (v === "") return null;
      if (!DECIMAL.test(String(v))) return "must be a non-negative amount with at most 2 decimals";
      return null;
    case "date":
      if (v === "") return null;
      if (typeof v !== "string" || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return "must be a date YYYY-MM-DD";
      return null;
    case "enum":
      if (v === "" && spec.allowEmpty) return null;
      if (!spec.values.includes(v)) return `must be one of ${spec.values.join(", ")}`;
      return null;
    case "enumArray":
      if (!Array.isArray(v) || v.length > spec.values.length || v.some((x) => !spec.values.includes(x))) {
        return `must be a list drawn from ${spec.values.join(", ")}`;
      }
      return null;
    case "url": {
      if (v === "") return null;
      if (typeof v !== "string" || v.length > 2048) return "must be a URL of at most 2048 characters";
      const c = checkExternalUrl(v);
      return c.ok ? null : c.reason;
    }
    default:
      return "has an unsupported type";
  }
}

/**
 * schema: { canonicalName: { ...spec, aliases?: [otherBodyKeys] } }
 * Throws VALIDATION_FAILED listing every bad field. `partial` skips `required`.
 */
export function validateBody(body, schema, { partial = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("VALIDATION_FAILED", 400, "Request body must be a JSON object");
  }
  const fields = {};
  for (const [name, spec] of Object.entries(schema)) {
    const keys = [name, ...(spec.aliases || [])];
    const present = keys.filter((k) => body[k] !== undefined);
    if (!present.length) {
      if (spec.required && !partial) fields[name] = "is required";
      continue;
    }
    for (const k of present) {
      const problem = checkValue(spec, body[k]);
      if (problem) { fields[k] = problem; break; }
      if (spec.required && !partial && (body[k] === null || body[k] === "")) { fields[k] = "is required"; break; }
    }
  }
  if (Object.keys(fields).length) {
    throw new ApiError("VALIDATION_FAILED", 400, "Some fields are invalid", { fields });
  }
}

/** Bounded list size: ?limit=1..MAX, default DEFAULT. */
export const LIST_DEFAULT = 200;
export const LIST_MAX = 500;
export function listLimit(req) {
  const raw = req.query?.limit;
  if (raw === undefined) return LIST_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > LIST_MAX) {
    throw new ApiError("VALIDATION_FAILED", 400, `limit must be a whole number from 1 to ${LIST_MAX}`);
  }
  return n;
}

const PLATFORMS = ["TikTok", "Instagram", "YouTube"];

export const SCHEMAS = {
  character: {
    name: { type: "string", min: 1, max: 120, required: true },
    characterType: { type: "string", max: 60, aliases: ["character_type"] },
    niche: { type: "string", max: 60 },
    persona: { type: "string", max: 5000 },
    gender: { type: "string", max: 60 },
    ethnicity: { type: "string", max: 60 },
    eyeColor: { type: "string", max: 60, aliases: ["eye_color"] },
    age: { type: "string", max: 20 },
    skinConditions: { type: "string", max: 2000, aliases: ["skin_conditions"] },
    advancedFeatures: { type: "string", max: 2000, aliases: ["advanced_features"] },
    optionalPrompt: { type: "string", max: 2000, aliases: ["optional_prompt"] },
    aspectRatio: { type: "enum", values: ["9:16", "1:1", "16:9"], aliases: ["aspect_ratio"] },
    qualitySetting: { type: "enum", values: ["4K", "1K"], aliases: ["quality_setting"] },
    referenceImageUrl: { type: "url", aliases: ["reference_image_url"] },
    bopaBackground: { type: "string", max: 1000, aliases: ["bopa_background"] },
    bopaOutfit: { type: "string", max: 1000, aliases: ["bopa_outfit"] },
    bopaPoses: { type: "string", max: 1000, aliases: ["bopa_poses"] },
    bopaAngles: { type: "string", max: 1000, aliases: ["bopa_angles"] },
    targetPlatforms: { type: "enumArray", values: PLATFORMS, aliases: ["target_platforms"] },
    status: { type: "enum", values: ["active", "paused", "archived"] },
    followerCount: { type: "int", aliases: ["follower_count"] },
    totalViews: { type: "int", aliases: ["total_views"] },
    engagementRate: { type: "decimal", aliases: ["engagement_rate"] },
    notes: { type: "string", max: 5000 },
  },
  content: {
    title: { type: "string", min: 1, max: 200, required: true },
    characterId: { type: "string", min: 1, max: 64, required: true, aliases: ["character_id"] },
    contentType: { type: "string", max: 60, aliases: ["content_type"] },
    platform: { type: "enum", values: PLATFORMS, allowEmpty: true },
    scheduledDate: { type: "date", aliases: ["scheduled_date"] },
    caption: { type: "string", max: 5000 },
    hashtags: { type: "string", max: 2000 },
    motionPrompt: { type: "string", max: 2000, aliases: ["motion_prompt"] },
    notes: { type: "string", max: 5000 },
    views: { type: "int" },
    likes: { type: "int" },
  },
  campaign: {
    name: { type: "string", min: 1, max: 200, required: true },
    brand: { type: "string", max: 120 },
    platform: { type: "enum", values: PLATFORMS, allowEmpty: true },
    brief: { type: "string", max: 5000 },
    requirements: { type: "string", max: 5000 },
    payoutAmount: { type: "decimal", aliases: ["payout_amount"] },
    deadline: { type: "date" },
    status: { type: "enum", values: ["active", "closed"] },
  },
  submission: {
    characterId: { type: "string", min: 1, max: 64, required: true, aliases: ["character_id"] },
    submissionUrl: { type: "url", aliases: ["submission_url"] },
    notes: { type: "string", max: 2000 },
  },
};
