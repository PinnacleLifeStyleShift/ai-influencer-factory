/**
 * AI Image Generation Service
 * Leonardo AI (primary) with Higgsfield (fallback).
 */

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

async function generateWithLeonardo(prompt, options = {}) {
  const apiKey = process.env.LEONARDO_API_KEY;
  if (!apiKey) throw new Error("LEONARDO_API_KEY not configured");

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

  console.log("Leonardo request:", JSON.stringify(body, null, 2));

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
    const errText = await createRes.text().catch(() => "");
    throw new Error(`Leonardo API error (${createRes.status}): ${errText}`);
  }

  const createData = await createRes.json();
  const generationId =
    createData?.sdGenerationJob?.generationId ||
    createData?.generationId;

  if (!generationId) {
    throw new Error("Leonardo did not return a generationId");
  }

  console.log("Leonardo generationId:", generationId);
  return await pollLeonardo(generationId, apiKey);
}

async function pollLeonardo(generationId, apiKey, maxAttempts = 30) {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < maxAttempts; i++) {
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

    const data = await res.json();
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

async function generateWithHiggsfield(prompt, options = {}) {
  const apiKey = process.env.HIGGSFIELD_API_KEY;
  const secret = process.env.HIGGSFIELD_SECRET;
  if (!apiKey || !secret) {
    throw new Error("HIGGSFIELD_API_KEY and HIGGSFIELD_SECRET not configured");
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

  console.log("Higgsfield request:", JSON.stringify(body, null, 2));

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
    const errorText = await response.text().catch(() => "");
    let errorDetail = errorText;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetail = errorJson.detail || errorJson.message || errorJson.error || errorText;
    } catch {}
    throw new Error(`Higgsfield API error (${response.status}): ${errorDetail}`);
  }

  const data = await response.json();
  console.log("Higgsfield response:", JSON.stringify(data, null, 2));

  if (data?.job_set_id) {
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
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < maxAttempts; i++) {
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

    const data = await response.json();
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
// Public API — tries Leonardo first, falls back to Higgsfield
// ---------------------------------------------------------------------------

export async function generateImage(prompt, options = {}) {
  let leonardoError;

  // Try Leonardo (primary)
  try {
    console.log("Trying Leonardo AI (primary)...");
    return await generateWithLeonardo(prompt, options);
  } catch (err) {
    leonardoError = err;
    console.error("Leonardo failed:", err.message);
  }

  // Fallback to Higgsfield
  try {
    console.log("Falling back to Higgsfield...");
    return await generateWithHiggsfield(prompt, options);
  } catch (higgsErr) {
    console.error("Higgsfield also failed:", higgsErr.message);
    throw new Error(
      `All image providers failed. Leonardo: ${leonardoError?.message || "unknown"}. Higgsfield: ${higgsErr.message}`
    );
  }
}
