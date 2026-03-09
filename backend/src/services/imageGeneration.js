/**
 * Higgsfield AI Image Generation Service
 * Builds prompts from character data and calls the text2image/soul API.
 */

/**
 * Builds a prompt string from character data for Higgsfield image generation.
 * Combines BOPA framework, appearance details, persona, and optional prompt.
 */
export function buildPromptFromCharacter(character) {
  const parts = [];

  // Character type and niche context
  if (character.characterType) parts.push(`${character.characterType} character`);
  if (character.niche) parts.push(`in the ${character.niche} niche`);

  // Appearance details
  const appearance = [];
  if (character.gender) appearance.push(character.gender);
  if (character.ethnicity) appearance.push(`${character.ethnicity} ethnicity`);
  if (character.age) appearance.push(`age ${character.age}`);
  if (character.eyeColor) appearance.push(`${character.eyeColor} eyes`);
  if (character.skinConditions) appearance.push(character.skinConditions);
  if (character.advancedFeatures) appearance.push(character.advancedFeatures);
  if (appearance.length > 0) parts.push(appearance.join(", "));

  // BOPA framework
  if (character.bopaBackground) parts.push(`Background: ${character.bopaBackground}`);
  if (character.bopaOutfit) parts.push(`Outfit: ${character.bopaOutfit}`);
  if (character.bopaPoses) parts.push(`Pose: ${character.bopaPoses}`);
  if (character.bopaAngles) parts.push(`Angle: ${character.bopaAngles}`);

  // Persona (first sentence)
  if (character.persona) {
    const firstSentence = character.persona.split(".")[0];
    parts.push(`Personality: ${firstSentence}`);
  }

  // Optional prompt — appended last so user intent takes precedence
  if (character.optionalPrompt) parts.push(character.optionalPrompt);

  return parts.join(". ").trim() || `AI influencer portrait of ${character.name}`;
}

/**
 * Maps character aspect_ratio to Higgsfield pixel dimensions.
 * New platform API uses "WIDTHxHEIGHT" format (e.g. "1696x960").
 */
function mapAspectRatio(aspectRatio) {
  const mapping = {
    "9:16": "960x1696",   // portrait
    "1:1": "1024x1024",   // square
    "16:9": "1696x960",   // landscape
  };
  return mapping[aspectRatio] || "1024x1024";
}

/**
 * Calls the Higgsfield AI platform text2image/soul endpoint.
 * Uses the new platform.higgsfield.ai API with hf-api-key + hf-secret auth.
 * @param {string} prompt - The image generation prompt
 * @param {Object} options - { aspectRatio, quality }
 * @returns {Promise<string>} - URL of the generated image
 */
export async function generateImage(prompt, options = {}) {
  const apiKey = process.env.HIGGSFIELD_API_KEY;
  const secret = process.env.HIGGSFIELD_SECRET;
  if (!apiKey || !secret) {
    throw new Error("HIGGSFIELD_API_KEY and HIGGSFIELD_SECRET environment variables must be configured");
  }

  const body = {
    params: {
      prompt,
      width_and_height: mapAspectRatio(options.aspectRatio || "1:1"),
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
    throw new Error(
      `Higgsfield API error (${response.status}): ${errorDetail}`
    );
  }

  const data = await response.json();
  console.log("Higgsfield response:", JSON.stringify(data, null, 2));

  // The new platform API returns a job_set_id for async processing.
  // If we get a job ID, poll for the result.
  if (data?.job_set_id) {
    return await pollForResult(data.job_set_id, apiKey, secret);
  }

  // Direct image URL response (fallback)
  const imageUrl =
    data?.images?.[0]?.url ||
    data?.results?.[0]?.url ||
    data?.image_url ||
    data?.url;

  if (!imageUrl) {
    throw new Error("No image URL returned from Higgsfield API");
  }

  return imageUrl;
}

/**
 * Polls the Higgsfield job status endpoint until the image is ready.
 * @param {string} jobSetId - The job set ID from the generation request
 * @param {string} apiKey - Higgsfield API key
 * @param {string} secret - Higgsfield secret
 * @returns {Promise<string>} - URL of the generated image
 */
async function pollForResult(jobSetId, apiKey, secret, maxAttempts = 30) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let i = 0; i < maxAttempts; i++) {
    await delay(3000); // Wait 3 seconds between polls

    const response = await fetch(`https://platform.higgsfield.ai/v1/job-sets/${jobSetId}`, {
      headers: {
        Accept: "application/json",
        "hf-api-key": apiKey,
        "hf-secret": secret,
      },
    });

    if (!response.ok) {
      console.log(`Poll attempt ${i + 1}: status ${response.status}`);
      continue;
    }

    const data = await response.json();
    console.log(`Poll attempt ${i + 1}: status=${data.status}`);

    if (data.status === "completed" || data.status === "done") {
      const imageUrl =
        data?.jobs?.[0]?.output?.url ||
        data?.jobs?.[0]?.result?.url ||
        data?.results?.[0]?.url ||
        data?.output?.url;

      if (imageUrl) return imageUrl;
      throw new Error("Job completed but no image URL found in response");
    }

    if (data.status === "failed" || data.status === "error") {
      throw new Error(`Image generation failed: ${data.error || "Unknown error"}`);
    }
  }

  throw new Error("Image generation timed out after polling");
}
