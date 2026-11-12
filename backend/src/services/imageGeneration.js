/**
 * AI Image Generation Service
 *
 * Provider adapters only. Every call goes through the generation gate
 * (services/generationGate.js), which enforces provider selection/approval,
 * the live-call switch and spending caps. Higgsfield is the selected primary
 * image provider; Leonardo is kept as an optional adapter but is not selected,
 * not approved, and is never used as an automatic fallback.
 *
 * NOTE: the Higgsfield endpoint below (platform.higgsfield.ai text2image/soul)
 * is the route recovered from the March 2026 source. Its current availability,
 * API entitlement, pricing and commercial-use terms are UNVERIFIED.
 */
import { ProviderError } from "./generationGate.js";
import { providerFetch, readJson, readText, deadlineIn, assertProviderUrl } from "./providerHttp.js";

// Every provider call is bounded and never follows redirects (review IF-R7, IF-R6).
const fetch = (url, init) => providerFetch(url, init);
// Overall polling budget per step: below the 20-minute generation lease.
const POLL_BUDGET_MS = Number(process.env.PROVIDER_POLL_BUDGET_MS) || 300000;


/**
 * Builds a prompt string from character data for image generation.
 * Combines BOPA framework, appearance details, persona, and optional prompt.
 */
export function buildPromptFromCharacter(character) {
  const parts = [];

  if (character.characterType) parts.push(`${character.characterType} character`);
  if (character.niche) parts.push(`in the ${character.niche} niche`);

  const appearance = [];
  if (character.gender) appearance.push(character.gender);
  if (character.ethnicity) appearance.push(`${character.ethnicity} ethnicity`);
  if (character.age) appearance.push(`age ${character.age}`);
  if (character.eyeColor) appearance.push(`${character.eyeColor} eyes`);
  if (character.skinConditions) appearance.push(character.skinConditions);
  if (character.advancedFeatures) appearance.push(character.advancedFeatures);
  if (appearance.length > 0) parts.push(appearance.join(", "));

  if (character.bopaBackground) parts.push(`Background: ${character.bopaBackground}`);
  if (character.bopaOutfit) parts.push(`Outfit: ${character.bopaOutfit}`);
  if (character.bopaPoses) parts.push(`Pose: ${character.bopaPoses}`);
  if (character.bopaAngles) parts.push(`Angle: ${character.bopaAngles}`);

  if (character.persona) {
    const firstSentence = character.persona.split(".")[0];
    parts.push(`Personality: ${firstSentence}`);
  }

  if (character.optionalPrompt) parts.push(character.optionalPrompt);

  return parts.join(". ").trim() || `AI influencer portrait of ${character.name}`;
}

// ---------------------------------------------------------------------------
// Leonardo AI (Primary)
// ---------------------------------------------------------------------------

function leonardoAspectRatio(aspectRatio) {
  // Leonardo expects width/height integers
  const mapping = {
    "9:16": { width: 576, height: 1024 },
    "1:1":  { width: 1024, height: 1024 },
    "16:9": { width: 1024, height: 576 },
  };
  return mapping[aspectRatio] || { width: 1024, height: 1024 };
}

async function generateWithLeonardo(prompt, options = {}, ctx = {}) {
  const apiKey = process.env.LEONARDO_API_KEY;
  if (!apiKey) throw new ProviderError("LEONARDO_API_KEY not configured", { submitted: false });

  const { width, height } = leonardoAspectRatio(options.aspectRatio || "1:1");

  const body = {
    prompt,
    modelId: "6b645e3a-d64f-4341-a6d8-7a3690fbf042", // Leonardo Phoenix
    width,
    height,
    num_images: 1,
    alchemy: true,
    presetStyle: "PHOTOGRAPHY",
  };

  const createRes = await fetch("https://cloud.leonardo.ai/api/rest/v1/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!createRes.ok) {
    const errText = await readText(createRes).catch(() => "");
    throw new Error(`Leonardo API error (${createRes.status}): ${errText}`);
  }

  const createData = await readJson(createRes);
  const generationId =
    createData?.sdGenerationJob?.generationId ||
    createData?.generationId;

  if (!generationId) {
    throw new Error("Leonardo did not return a generationId");
  }
  // Accepted: record the provider's id so an interrupted job can be reconciled.
  await ctx.onAccepted?.(generationId);

  return await pollLeonardo(generationId, apiKey);
}

async function pollLeonardo(generationId, apiKey, maxAttempts = 30) {
  const until = deadlineIn(POLL_BUDGET_MS);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < maxAttempts; i++) {
    if (Date.now() >= until.at) break;
    await delay(4000);

    const res = await fetch(
      `https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    if (!res.ok) {
      console.log(`Leonardo poll ${i + 1}: HTTP ${res.status}`);
      continue;
    }

    const data = await readJson(res);
    const status = data?.generations_by_pk?.status;
    console.log(`Leonardo poll ${i + 1}: status=${status}`);

    if (status === "COMPLETE") {
      const imageUrl = data?.generations_by_pk?.generated_images?.[0]?.url;
      if (imageUrl) return imageUrl;
      throw new Error("Leonardo job complete but no image URL found");
    }

    if (status === "FAILED") {
      throw new Error("Leonardo image generation failed");
    }
  }

  throw new Error("Leonardo generation timed out after polling");
}

// ---------------------------------------------------------------------------
// Higgsfield (Fallback)
// ---------------------------------------------------------------------------

function higgsAspectRatio(aspectRatio) {
  const mapping = {
    "9:16": "960x1696",
    "1:1": "1536x1536",
    "16:9": "1696x960",
  };
  return mapping[aspectRatio] || "1536x1536";
}

async function generateWithHiggsfield(prompt, options = {}, ctx = {}) {
  const apiKey = process.env.HIGGSFIELD_API_KEY;
  const secret = process.env.HIGGSFIELD_SECRET;
  if (!apiKey || !secret) {
    throw new ProviderError("HIGGSFIELD_API_KEY and HIGGSFIELD_SECRET not configured", { submitted: false });
  }

  const body = {
    params: {
      prompt,
      width_and_height: higgsAspectRatio(options.aspectRatio || "1:1"),
      quality: "720p",
      batch_size: 1,
      enhance_prompt: true,
    },
  };

  const response = await fetch("https://platform.higgsfield.ai/v1/text2image/soul", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "hf-api-key": apiKey,
      "hf-secret": secret,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await readText(response).catch(() => "");
    let errorDetail = errorText;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = errorJson.detail || errorJson.message || errorJson.error || errorText;
    } catch {}
    throw new Error(`Higgsfield API error (${response.status}): ${errorDetail}`);
  }

  const data = await readJson(response);
  if (data?.job_set_id) {
    // Accepted: record the provider's id so an interrupted job can be reconciled.
    await ctx.onAccepted?.(data.job_set_id);
    return await pollHiggsfield(data.job_set_id, apiKey, secret);
  }

  const imageUrl =
    data?.images?.[0]?.url ||
    data?.results?.[0]?.url ||
    data?.image_url ||
    data?.url;

  if (!imageUrl) throw new Error("No image URL from Higgsfield");
  return imageUrl;
}

async function pollHiggsfield(jobSetId, apiKey, secret, maxAttempts = 30) {
  const until = deadlineIn(POLL_BUDGET_MS);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < maxAttempts; i++) {
    if (Date.now() >= until.at) break;
    await delay(3000);

    const response = await fetch(`https://platform.higgsfield.ai/v1/job-sets/${jobSetId}`, {
      headers: {
        Accept: "application/json",
        "hf-api-key": apiKey,
        "hf-secret": secret,
      },
    });

    if (!response.ok) {
      console.log(`Higgsfield poll ${i + 1}: HTTP ${response.status}`);
      continue;
    }

    const data = await readJson(response);
    console.log(`Higgsfield poll ${i + 1}: status=${data.status}`);

    if (data.status === "completed" || data.status === "done") {
      const imageUrl =
        data?.jobs?.[0]?.output?.url ||
        data?.jobs?.[0]?.result?.url ||
        data?.results?.[0]?.url ||
        data?.output?.url;
      if (imageUrl) return imageUrl;
      throw new Error("Higgsfield job completed but no image URL found");
    }

    if (data.status === "failed" || data.status === "error") {
      throw new Error(`Higgsfield generation failed: ${data.error || "Unknown error"}`);
    }
  }

  throw new Error("Higgsfield generation timed out after polling");
}

// ---------------------------------------------------------------------------
// Adapter registry and public API
// ---------------------------------------------------------------------------

/**
 * Keyed by "provider:model". Presence here does not mean approved.
 *
 * capabilities declare what an adapter really sends. WHY: storing a reference
 * URL proves nothing about identity consistency if the adapter never sends
 * it; requests that need a capability are refused before any spend.
 *  - referenceConditioning: reference images are sent to steer identity
 *  - sourceImage: an input image is animated/edited (image-to-video)
 * The recovered Higgsfield and Leonardo calls are text-to-image only.
 */
export const imageAdapters = {
  "higgsfield:soul": {
    capabilities: { referenceConditioning: false, sourceImage: false },
    generate: ({ prompt, options }, ctx) =>
      generateWithHiggsfield(prompt, options, ctx).then((imageUrl) => ({ imageUrl })),
  },
  "leonardo:phoenix": {
    capabilities: { referenceConditioning: false, sourceImage: false },
    generate: ({ prompt, options }, ctx) =>
      generateWithLeonardo(prompt, options, ctx).then((imageUrl) => ({ imageUrl })),
  },
};

/**
 * Generate one image through the given generation gate (selected, approved
 * provider only). The gate is always passed in explicitly by the caller.
 */
export async function generateImage(gate, prompt, options = {}, { idempotencyKey, requestHash } = {}) {
  if (!gate) throw new Error("generateImage requires a generation gate");
  const result = await gate.run("image", { prompt, options }, { idempotencyKey, requestHash });
  return result.imageUrl;
}
