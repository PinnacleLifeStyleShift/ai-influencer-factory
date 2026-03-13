/**
 * Kling AI Video Generation Service
 * Generates short videos from text or images using the Kling API.
 * Auth: JWT signed with HS256 using Access Key + Secret Key.
 */

import crypto from "crypto";

// ---------------------------------------------------------------------------
// JWT helper (HS256) — no external dependency needed
// ---------------------------------------------------------------------------

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
  const payload = {
    iss: accessKey,
    exp: now + 1800, // 30 min
    nbf: now - 5,
  };

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

// ---------------------------------------------------------------------------
// Kling API helpers
// ---------------------------------------------------------------------------

const KLING_BASE = "https://api.klingai.com";

function getAuth() {
  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;
  if (!accessKey || !secretKey) {
    throw new Error("KLING_ACCESS_KEY and KLING_SECRET_KEY must be configured");
  }
  return createJwt(accessKey, secretKey);
}

// ---------------------------------------------------------------------------
// Text-to-Video
// ---------------------------------------------------------------------------

export async function generateVideoFromText(prompt, options = {}) {
  const token = getAuth();

  const body = {
    model_name: options.model || "kling-v2-5-turbo",
    prompt,
    cfg_scale: options.cfgScale || 0.5,
    mode: options.mode || "std",
    aspect_ratio: options.aspectRatio || "16:9",
    duration: options.duration || "5",
  };

  console.log("Kling text-to-video request:", JSON.stringify(body, null, 2));

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
  console.log("Kling text2video response:", JSON.stringify(data, null, 2));

  const taskId = data?.data?.task_id;
  if (!taskId) throw new Error("Kling did not return a task_id");

  return await pollKlingTask(taskId, token, 60, "text2video");
}

// ---------------------------------------------------------------------------
// Image-to-Video
// ---------------------------------------------------------------------------

export async function generateVideoFromImage(imageUrl, prompt = "", options = {}) {
  const token = getAuth();

  const body = {
    model_name: options.model || "kling-v2-5-turbo",
    image: imageUrl,
    prompt: prompt || undefined,
    cfg_scale: options.cfgScale || 0.5,
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
  console.log("Kling image2video response:", JSON.stringify(data, null, 2));

  const taskId = data?.data?.task_id;
  if (!taskId) throw new Error("Kling did not return a task_id");

  return await pollKlingTask(taskId, token, 60, "image2video");
}

// ---------------------------------------------------------------------------
// Poll for task completion
// ---------------------------------------------------------------------------

async function pollKlingTask(taskId, token, maxAttempts = 60, endpoint = "image2video") {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < maxAttempts; i++) {
    await delay(10000); // Kling videos take 3-6 min — poll every 10s

    const res = await fetch(`${KLING_BASE}/v1/videos/${endpoint}/${taskId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      console.log(`Kling poll ${i + 1}: HTTP ${res.status}`);
      continue;
    }

    const data = await res.json();
    const status = data?.data?.task_status;
    console.log(`Kling poll ${i + 1}: status=${status}`);

    if (status === "succeed") {
      const videoUrl =
        data?.data?.task_result?.videos?.[0]?.url ||
        data?.data?.task_result?.videos?.[0]?.video_url;
      if (videoUrl) return { videoUrl, taskId };
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
