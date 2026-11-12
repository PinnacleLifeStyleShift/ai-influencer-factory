/**
 * Video Generation Service
 *
 * Provider adapters only. Every call goes through the generation gate
 * (services/generationGate.js). No video provider is selected by default:
 * the recovered fal.ai/Kling adapters are retained as optional, unapproved
 * options, and there is no automatic fallback between them. A Higgsfield
 * video route has not been verified and is not implemented here.
 */

import crypto from "crypto";
import { ProviderError } from "./generationGate.js";
import { providerFetch, readJson, readText, deadlineIn, assertProviderUrl } from "./providerHttp.js";

// Every provider call is bounded and never follows redirects (review IF-R7, IF-R6).
const fetch = (url, init) => providerFetch(url, init);
// Overall polling budget per step: below the 20-minute generation lease.
const POLL_BUDGET_MS = Number(process.env.PROVIDER_POLL_BUDGET_MS) || 900000;


// ---------------------------------------------------------------------------
// fal.ai (Primary) — Kling image-to-video via fal queue API
// ---------------------------------------------------------------------------

const FAL_ENDPOINT = "fal-ai/kling-video/v2.1/standard/image-to-video";

async function generateWithFal(imageUrl, prompt, options = {}, ctx = {}) {
  const falKey = process.env.FAL_KEY;
  if (!falKey) throw new ProviderError("FAL_KEY not configured", { submitted: false });

  const body = {
    prompt: prompt || "Subtle natural movement, gentle motion, cinematic lighting",
    image_url: imageUrl,
    duration: options.duration || "5",
    aspect_ratio: options.aspectRatio || "9:16",
    negative_prompt: "blur, distort, low quality, jitter",
    cfg_scale: 0.5,
  };

  // Step 1: Submit job
  const submitRes = await fetch(`https://queue.fal.run/${FAL_ENDPOINT}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${falKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!submitRes.ok) {
    const errText = await readText(submitRes).catch(() => "");
    throw new Error(`fal.ai submit error (${submitRes.status}): ${errText}`);
  }

  const job = await readJson(submitRes);
  const requestId = job.request_id;
  if (!requestId) throw new Error("fal.ai did not return a request_id");
  // Accepted: record the provider's id so an interrupted job can be reconciled.
  await ctx.onAccepted?.(requestId);

  console.log("fal.ai job submitted:", requestId);

  // Step 2: poll the URLs from the submit response, but only if they are
  // fal's own queue: the key is attached to them (review IF-R6). A bad URL
  // after acceptance is an unknown outcome for the gate, never "not sent".
  const FAL_QUEUE = { host: "queue.fal.run", pathPrefix: "/fal-ai/" };
  const statusUrl = assertProviderUrl(job.status_url, FAL_QUEUE);
  const responseUrl = assertProviderUrl(job.response_url, FAL_QUEUE);
  return await pollFalJob(statusUrl, responseUrl, falKey);
}

async function pollFalJob(statusUrl, responseUrl, falKey, maxAttempts = 60) {
  const until = deadlineIn(POLL_BUDGET_MS);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < maxAttempts; i++) {
    if (Date.now() >= until.at) break;
    await delay(10000); // poll every 10s — videos take 3-6 min

    const res = await fetch(statusUrl, {
      headers: { Authorization: `Key ${falKey}` },
    });

    if (!res.ok) {
      console.log(`fal.ai poll ${i + 1}: HTTP ${res.status}`);
      continue;
    }

    const data = await readJson(res);
    console.log(`fal.ai poll ${i + 1}: status=${data.status}`);

    if (data.status === "COMPLETED") {
      // Step 3: Get result using response URL from submit
      const resultRes = await fetch(responseUrl, {
        headers: { Authorization: `Key ${falKey}` },
      });
      if (!resultRes.ok) {
        throw new Error(`fal.ai result fetch failed (${resultRes.status})`);
      }
      const result = await readJson(resultRes);
      const videoUrl = result?.video?.url;
      if (!videoUrl) throw new Error("fal.ai completed but no video URL found");
      return videoUrl;
    }

    if (data.status === "FAILED" || data.error) {
      throw new Error(`fal.ai video generation failed: ${data.error || "Unknown error"}`);
    }
  }

  throw new Error("fal.ai video generation timed out after polling");
}

// ---------------------------------------------------------------------------
// Direct Kling API (Fallback)
// ---------------------------------------------------------------------------

const KLING_BASE = "https://api.klingai.com";

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createJwt(accessKey, secretKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { iss: accessKey, exp: now + 1800, nbf: now - 5 };

  const segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(payload)),
  ];
  const signingInput = segments.join(".");
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(signingInput)
    .digest();

  return `${signingInput}.${base64url(signature)}`;
}

function getKlingAuth() {
  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;
  if (!accessKey || !secretKey) {
    throw new ProviderError("KLING_ACCESS_KEY and KLING_SECRET_KEY must be configured", { submitted: false });
  }
  return createJwt(accessKey, secretKey);
}

async function generateWithKling(imageUrl, prompt, options = {}, ctx = {}) {
  const token = getKlingAuth();

  const body = {
    model_name: options.model || "kling-v2-1",
    image: imageUrl,
    prompt: prompt || undefined,
    cfg_scale: 0.5,
    mode: options.mode || "std",
    duration: options.duration || "5",
  };

  const res = await fetch(`${KLING_BASE}/v1/videos/image2video`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await readText(res).catch(() => "");
    throw new Error(`Kling API error (${res.status}): ${errText}`);
  }

  const data = await readJson(res);
  const taskId = data?.data?.task_id;
  if (!taskId) throw new Error("Kling did not return a task_id");
  await ctx.onAccepted?.(taskId);

  console.log("Kling taskId:", taskId);
  return await pollKlingTask(taskId, token);
}

async function pollKlingTask(taskId, token, maxAttempts = 60) {
  const until = deadlineIn(POLL_BUDGET_MS);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < maxAttempts; i++) {
    if (Date.now() >= until.at) break;
    await delay(10000);

    const res = await fetch(`${KLING_BASE}/v1/videos/image2video/${taskId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      console.log(`Kling poll ${i + 1}: HTTP ${res.status}`);
      continue;
    }

    const data = await readJson(res);
    const status = data?.data?.task_status;
    console.log(`Kling poll ${i + 1}: status=${status}`);

    if (status === "succeed") {
      const videoUrl = data?.data?.task_result?.videos?.[0]?.url;
      if (videoUrl) return videoUrl;
      throw new Error("Kling task succeeded but no video URL found");
    }

    if (status === "failed") {
      throw new Error(
        `Kling video generation failed: ${data?.data?.task_status_msg || "Unknown error"}`
      );
    }
  }

  throw new Error("Kling video generation timed out after polling");
}

async function klingTextToVideo(prompt, options = {}) {
  // Text-to-video only available via direct Kling
  const token = getKlingAuth();
  const body = {
    model_name: options.model || "kling-v2-1",
    prompt,
    cfg_scale: 0.5,
    mode: options.mode || "std",
    aspect_ratio: options.aspectRatio || "16:9",
    duration: options.duration || "5",
  };

  const res = await fetch(`${KLING_BASE}/v1/videos/text2video`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await readText(res).catch(() => "");
    throw new Error(`Kling API error (${res.status}): ${errText}`);
  }

  const data = await readJson(res);
  const taskId = data?.data?.task_id;
  if (!taskId) throw new Error("Kling did not return a task_id");

  const videoUrl = await pollKlingTask(taskId, token);
  return { videoUrl };
}

// ---------------------------------------------------------------------------
// Adapter registry and public API
// ---------------------------------------------------------------------------

/** Keyed by "provider:model". Presence here does not mean approved. */
export const videoAdapters = {
  "fal:kling-v2.1-i2v": {
    capabilities: { referenceConditioning: false, sourceImage: true },
    generate: async ({ imageUrl, prompt, options }, ctx) => {
      if (!imageUrl) throw new ProviderError("fal:kling-v2.1-i2v requires a source image", { submitted: false });
      return { videoUrl: await generateWithFal(imageUrl, prompt, options, ctx) };
    },
  },
  "kling:kling-v2-1": {
    capabilities: { referenceConditioning: false, sourceImage: true },
    generate: async ({ imageUrl, prompt, options }, ctx) =>
      imageUrl
        ? { videoUrl: await generateWithKling(imageUrl, prompt, options, ctx) }
        : klingTextToVideo(prompt, options),
  },
};

/** Video (image-to-video when imageUrl is given) through the given gate. */
export async function generateVideo(gate, { imageUrl = null, prompt = "", options = {} }, { idempotencyKey, requestHash } = {}) {
  if (!gate) throw new Error("generateVideo requires a generation gate");
  const result = await gate.run("video", { imageUrl, prompt, options }, { idempotencyKey, requestHash });
  return { videoUrl: result.videoUrl };
}
