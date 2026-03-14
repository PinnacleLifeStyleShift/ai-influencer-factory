/**
 * Video Generation Service
 * fal.ai (primary — Kling via fal) with direct Kling API (fallback).
 */

import crypto from "crypto";

// ---------------------------------------------------------------------------
// fal.ai (Primary) — Kling image-to-video via fal queue API
// ---------------------------------------------------------------------------

const FAL_ENDPOINT = "fal-ai/kling-video/v2.1/standard/image-to-video";

async function generateWithFal(imageUrl, prompt, options = {}) {
  const falKey = process.env.FAL_KEY;
  if (!falKey) throw new Error("FAL_KEY not configured");

  const body = {
    prompt: prompt || "Subtle natural movement, gentle motion, cinematic lighting",
    image_url: imageUrl,
    duration: options.duration || "5",
    aspect_ratio: options.aspectRatio || "9:16",
    negative_prompt: "blur, distort, low quality, jitter",
    cfg_scale: 0.5,
  };

  console.log("fal.ai submit:", JSON.stringify(body, null, 2));

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
    const errText = await submitRes.text().catch(() => "");
    throw new Error(`fal.ai submit error (${submitRes.status}): ${errText}`);
  }

  const job = await submitRes.json();
  const requestId = job.request_id;
  if (!requestId) throw new Error("fal.ai did not return a request_id");

  console.log("fal.ai job submitted:", requestId);
  console.log("fal.ai status_url:", job.status_url);
  console.log("fal.ai response_url:", job.response_url);

  // Step 2: Poll for completion using URLs from submit response
  return await pollFalJob(job.status_url, job.response_url, falKey);
}

async function pollFalJob(statusUrl, responseUrl, falKey, maxAttempts = 60) {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < maxAttempts; i++) {
    await delay(10000); // poll every 10s — videos take 3-6 min

    const res = await fetch(statusUrl, {
      headers: { Authorization: `Key ${falKey}` },
    });

    if (!res.ok) {
      console.log(`fal.ai poll ${i + 1}: HTTP ${res.status}`);
      continue;
    }

    const data = await res.json();
    console.log(`fal.ai poll ${i + 1}: status=${data.status}`);

    if (data.status === "COMPLETED") {
      // Step 3: Get result using response URL from submit
      const resultRes = await fetch(responseUrl, {
        headers: { Authorization: `Key ${falKey}` },
      });
      if (!resultRes.ok) {
        throw new Error(`fal.ai result fetch failed (${resultRes.status})`);
      }
      const result = await resultRes.json();
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
    throw new Error("KLING_ACCESS_KEY and KLING_SECRET_KEY must be configured");
  }
  return createJwt(accessKey, secretKey);
}

async function generateWithKling(imageUrl, prompt, options = {}) {
  const token = getKlingAuth();

  const body = {
    model_name: options.model || "kling-v2-1",
    image: imageUrl,
    prompt: prompt || undefined,
    cfg_scale: 0.5,
    mode: options.mode || "std",
    duration: options.duration || "5",
  };

  console.log("Kling image-to-video request:", JSON.stringify(body, null, 2));

  const res = await fetch(`${KLING_BASE}/v1/videos/image2video`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Kling API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const taskId = data?.data?.task_id;
  if (!taskId) throw new Error("Kling did not return a task_id");

  console.log("Kling taskId:", taskId);
  return await pollKlingTask(taskId, token);
}

async function pollKlingTask(taskId, token, maxAttempts = 60) {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < maxAttempts; i++) {
    await delay(10000);

    const res = await fetch(`${KLING_BASE}/v1/videos/image2video/${taskId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      console.log(`Kling poll ${i + 1}: HTTP ${res.status}`);
      continue;
    }

    const data = await res.json();
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

// ---------------------------------------------------------------------------
// Public API — tries fal.ai first, falls back to direct Kling
// ---------------------------------------------------------------------------

export async function generateVideoFromImage(imageUrl, prompt = "", options = {}) {
  let falError;

  // Try fal.ai (primary)
  if (process.env.FAL_KEY) {
    try {
      console.log("Trying fal.ai (primary)...");
      const videoUrl = await generateWithFal(imageUrl, prompt, options);
      return { videoUrl };
    } catch (err) {
      falError = err;
      console.error("fal.ai failed:", err.message);
    }
  }

  // Fallback to direct Kling API
  if (process.env.KLING_ACCESS_KEY && process.env.KLING_SECRET_KEY) {
    try {
      console.log("Falling back to direct Kling API...");
      const videoUrl = await generateWithKling(imageUrl, prompt, options);
      return { videoUrl };
    } catch (klingErr) {
      console.error("Kling also failed:", klingErr.message);
      throw new Error(
        `All video providers failed. fal.ai: ${falError?.message || "not configured"}. Kling: ${klingErr.message}`
      );
    }
  }

  throw new Error(
    `Video generation failed. fal.ai: ${falError?.message || "FAL_KEY not configured"}. Kling: KLING keys not configured.`
  );
}

export async function generateVideoFromText(prompt, options = {}) {
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
    const errText = await res.text().catch(() => "");
    throw new Error(`Kling API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const taskId = data?.data?.task_id;
  if (!taskId) throw new Error("Kling did not return a task_id");

  const videoUrl = await pollKlingTask(taskId, token);
  return { videoUrl };
}
