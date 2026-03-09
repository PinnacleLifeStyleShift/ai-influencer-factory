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
 * Maps character aspect_ratio to Higgsfield width_and_height format.
 */
function mapAspectRatio(aspectRatio) {
  const mapping = {
    "9:16": "720p_9:16",
    "1:1": "720p_1:1",
    "16:9": "720p_16:9",
  };
  return mapping[aspectRatio] || "720p_1:1";
}

/**
 * Calls the Higgsfield AI text2image/soul endpoint.
 * @param {string} prompt - The image generation prompt
 * @param {Object} options - { aspectRatio, quality }
 * @returns {Promise<string>} - URL of the generated image
 */
export async function generateImage(prompt, options = {}) {
  const apiKey = process.env.HIGGSFIELD_API_KEY;
  if (!apiKey) {
    throw new Error("HIGGSFIELD_API_KEY environment variable is not configured");
  }

  const body = {
    prompt,
    width_and_height: mapAspectRatio(options.aspectRatio || "1:1"),
    quality: options.quality || "4K",
    batch_size: 1,
  };

  console.log("Higgsfield request:", JSON.stringify(body, null, 2));

  const response = await fetch("https://api.higgsfield.ai/v1/text2image/soul", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      `Higgsfield API error (${response.status}): ${errorData.message || errorData.error || response.statusText}`
    );
  }

  const data = await response.json();
  console.log("Higgsfield response:", JSON.stringify(data, null, 2));

  // Extract image URL — try multiple possible paths in the response
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
