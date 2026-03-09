// ─── Caption Generation Service ──────────────────────────────
// Generates social media captions and hashtags for content.
// Platform-specific formatting for TikTok, Instagram, YouTube.

const EMOJI_SETS = {
  Fashion: ["👗", "✨", "💅", "🔥", "💫", "🤍", "👠", "🪞"],
  Beauty: ["💄", "✨", "🌸", "💕", "🪷", "💋", "🌟", "💗"],
  Fitness: ["💪", "🏋️", "🔥", "⚡", "🏃", "💯", "🎯", "🫶"],
  Lifestyle: ["✨", "🌿", "☕", "🌙", "💫", "🤍", "🕊️", "🌸"],
  Tech: ["💻", "🔧", "⚡", "🤖", "📱", "🎮", "🖥️", "💡"],
  Food: ["🍳", "😋", "🔥", "🍕", "🥗", "👨‍🍳", "💯", "🤤"],
  Travel: ["✈️", "🌍", "🏖️", "🗺️", "🌅", "📸", "🏔️", "🌴"],
  Gaming: ["🎮", "🕹️", "⚡", "🔥", "💀", "🏆", "👾", "🎯"],
};

const CAPTION_STYLES = {
  TikTok: {
    maxLength: 300,
    style: "Short, punchy, with trending phrases. Use 3-5 hashtags max.",
    templates: [
      "{hook} {emoji1}\n\n{body}\n\n{cta} {emoji2}",
      "{emoji1} {hook}\n\n{cta}\n\n{hashtags}",
      "{hook} {emoji1}{emoji2}\n\nFull video on my page {emoji3}",
      "POV: {hook} {emoji1}\n\n{cta}",
    ],
  },
  Instagram: {
    maxLength: 2200,
    style: "Longer, storytelling format. Can be personal and detailed. 15-30 hashtags.",
    templates: [
      "{hook} {emoji1}\n\n{body}\n\n{cta}\n\n.\n.\n.\n{hashtags}",
      "{emoji1} {hook}\n\n{body}\n\nWhat do you think? Let me know below {emoji2}\n\n{hashtags}",
      "{hook}\n\n{body}\n\nSave this for later! {emoji1}\n\n{hashtags}",
    ],
  },
  YouTube: {
    maxLength: 5000,
    style: "Descriptive, SEO-friendly. Include timestamps and links.",
    templates: [
      "{hook}\n\n{body}\n\n{cta}\n\nTimestamps:\n0:00 — Intro\n0:30 — Main Content\n\n{hashtags}",
      "{hook} {emoji1}\n\n{body}\n\nDon't forget to LIKE and SUBSCRIBE!\n\n{hashtags}",
    ],
  },
};

const TRENDING_PHRASES = {
  TikTok: [
    "no because this is actually insane",
    "the way this changed everything",
    "this needs more attention",
    "I'm obsessed with this",
    "you need to try this rn",
    "the girlies need to know about this",
    "main character energy",
    "this is the one",
  ],
  Instagram: [
    "This one's for the books",
    "Good things take time",
    "Living for moments like these",
    "Creating magic one post at a time",
    "Some things are worth the wait",
    "Grateful for this journey",
  ],
  YouTube: [
    "In today's video",
    "I've been wanting to share this",
    "This is something I've been working on",
    "Let's dive right in",
    "You guys have been asking about this",
  ],
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickMultiple(arr, count) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

/**
 * Generate a social media caption
 * @param {Object} script - Script object with title, hook, body, callToAction
 * @param {Object} character - Character object from DB
 * @param {string} platform - TikTok, Instagram, or YouTube
 * @returns {Object} Caption with text and metadata
 */
export function generateCaption(script, character, platform = "TikTok") {
  const niche = character?.niche || "Lifestyle";
  const emojis = EMOJI_SETS[niche] || EMOJI_SETS.Lifestyle;
  const captionStyle = CAPTION_STYLES[platform] || CAPTION_STYLES.TikTok;
  const trendPhrase = pickRandom(TRENDING_PHRASES[platform] || TRENDING_PHRASES.TikTok);

  // Build caption parts
  const hook = script?.hook || trendPhrase;
  const shortHook = hook.length > 80 ? hook.substring(0, 77) + "..." : hook;
  const body = buildCaptionBody(script, platform, niche);
  const cta = script?.callToAction || "Follow for more!";
  const hashtags = generateHashtags(script?.title || niche, platform, niche);

  // Pick emojis
  const [emoji1, emoji2, emoji3] = pickMultiple(emojis, 3);

  // Fill template
  const template = pickRandom(captionStyle.templates);
  let caption = template
    .replace("{hook}", platform === "TikTok" ? shortHook : hook)
    .replace("{body}", body)
    .replace("{cta}", cta)
    .replace("{hashtags}", hashtags.formatted)
    .replace("{emoji1}", emoji1)
    .replace("{emoji2}", emoji2)
    .replace("{emoji3}", emoji3 || emoji1);

  // Trim to max length
  if (caption.length > captionStyle.maxLength) {
    caption = caption.substring(0, captionStyle.maxLength - 3) + "...";
  }

  return {
    caption,
    platform,
    style: captionStyle.style,
    hashtags: hashtags.list,
    hashtagString: hashtags.formatted,
    characterLength: caption.length,
    maxLength: captionStyle.maxLength,
  };
}

function buildCaptionBody(script, platform, niche) {
  if (!script?.body) {
    return `Creating ${niche.toLowerCase()} content that inspires and entertains.`;
  }

  // For TikTok, keep it very short
  if (platform === "TikTok") {
    const firstSentence = script.body.split(/[.\n]/)[0];
    return firstSentence.length > 100 ? firstSentence.substring(0, 97) + "..." : firstSentence;
  }

  // For Instagram, use more of the body
  if (platform === "Instagram") {
    const lines = script.body.split("\n").filter((l) => l.trim());
    return lines.slice(0, 4).join("\n");
  }

  // For YouTube, use full body
  return script.body;
}

/**
 * Generate relevant hashtags for a topic
 * @param {string} topic - Content topic
 * @param {string} platform - TikTok, Instagram, or YouTube
 * @param {string} niche - Content niche
 * @returns {Object} { list: string[], formatted: string }
 */
export function generateHashtags(topic = "", platform = "TikTok", niche = "Lifestyle") {
  const baseTags = [];

  // Niche hashtags
  const nicheMap = {
    Fashion: ["fashion", "style", "ootd", "fashioninspo", "outfitideas", "styleguide", "fashiontok", "whatiwore"],
    Beauty: ["beauty", "makeup", "skincare", "beautytips", "glowup", "beautyroutine", "skincaretips", "makeuptutorial"],
    Fitness: ["fitness", "workout", "gym", "fitnessmotivation", "healthylifestyle", "exercise", "fitlife", "gains"],
    Lifestyle: ["lifestyle", "dailylife", "dayinmylife", "aesthetic", "vibes", "lifestyleblogger", "everydaylife"],
    Tech: ["tech", "technology", "gadgets", "techreview", "innovation", "techtok", "unboxing", "setup"],
    Food: ["food", "foodie", "recipe", "cooking", "foodtok", "homecooking", "yummy", "delicious"],
    Travel: ["travel", "travelgram", "wanderlust", "explore", "traveltok", "adventure", "travelblogger"],
    Gaming: ["gaming", "gamer", "gameplay", "videogames", "gamingcommunity", "streamer", "gamertok"],
  };

  const nicheTags = nicheMap[niche] || nicheMap.Lifestyle;
  baseTags.push(...nicheTags);

  // Platform-specific viral tags
  const platformTags = {
    TikTok: ["fyp", "foryou", "viral", "trending", "foryoupage"],
    Instagram: ["instagood", "photooftheday", "instadaily", "explore", "reels", "instareels"],
    YouTube: ["youtube", "shorts", "subscribe", "ytshorts", "youtuber"],
  };
  baseTags.push(...(platformTags[platform] || platformTags.TikTok));

  // Topic-based tags (extract keywords)
  const topicWords = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  baseTags.push(...topicWords.slice(0, 3));

  // Deduplicate and format
  const unique = [...new Set(baseTags)];

  // Platform-specific count
  const count = platform === "TikTok" ? 5 : platform === "Instagram" ? 20 : 8;
  const selected = unique.slice(0, count);
  const list = selected.map((t) => `#${t}`);

  return {
    list,
    formatted: list.join(" "),
    count: list.length,
  };
}
