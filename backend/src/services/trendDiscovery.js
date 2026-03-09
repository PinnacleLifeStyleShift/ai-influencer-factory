// ─── Trend Discovery Service ─────────────────────────────────
// Discovers trending topics across social media platforms.
// Currently uses curated/simulated data. Will integrate real APIs later.

const TREND_TEMPLATES = {
  TikTok: [
    { category: "challenge", topics: ["Dance challenge", "Outfit transition", "Glow-up challenge", "What I eat in a day", "Get ready with me"] },
    { category: "tutorial", topics: ["Quick makeup tutorial", "Hair styling hack", "Skincare routine", "Fitness tip", "Recipe in 60 seconds"] },
    { category: "storytelling", topics: ["POV story", "Day in my life", "Storytime", "Unpopular opinion", "Things that just make sense"] },
    { category: "trending_audio", topics: ["Viral sound remix", "Lip sync trend", "Aesthetic transition", "Before and after", "Duet reaction"] },
    { category: "lifestyle", topics: ["Morning routine", "Night routine", "Apartment tour", "Haul video", "Productivity hack"] },
  ],
  Instagram: [
    { category: "reels", topics: ["Aesthetic reel", "Behind the scenes", "Mini vlog", "Outfit of the day", "Travel reel"] },
    { category: "carousel", topics: ["Tips carousel", "Photo dump", "Before & after", "Step by step guide", "Myth vs fact"] },
    { category: "stories", topics: ["Q&A session", "Poll engagement", "This or that", "Day recap", "Sneak peek"] },
    { category: "aesthetic", topics: ["Feed aesthetic", "Color palette post", "Flat lay", "Mirror selfie series", "Golden hour shoot"] },
    { category: "engagement", topics: ["Save this post", "Share with a friend", "Comment your answer", "Rate this look", "Caption this"] },
  ],
  YouTube: [
    { category: "shorts", topics: ["Quick tip short", "Satisfying clip", "Life hack", "Did you know", "Mini review"] },
    { category: "vlog", topics: ["Day in the life", "Weekly vlog", "Travel vlog", "Shopping vlog", "Moving vlog"] },
    { category: "tutorial", topics: ["Full tutorial", "Beginner guide", "Deep dive", "How to style", "Complete routine"] },
    { category: "reaction", topics: ["Trying viral products", "First time trying", "Honest review", "Reacting to comments", "Testing TikTok hacks"] },
    { category: "list", topics: ["Top 10 list", "Best of the month", "Things I regret buying", "Favorites roundup", "Worst to best ranking"] },
  ],
};

const NICHE_HASHTAGS = {
  Fashion: ["#fashion", "#style", "#ootd", "#fashionista", "#streetstyle", "#outfitinspo"],
  Beauty: ["#beauty", "#makeup", "#skincare", "#glam", "#beautytips", "#mua"],
  Fitness: ["#fitness", "#workout", "#gym", "#fitnessmotivation", "#health", "#training"],
  Lifestyle: ["#lifestyle", "#daily", "#vibes", "#aesthetic", "#life", "#mood"],
  Tech: ["#tech", "#gadgets", "#technology", "#review", "#unboxing", "#techreview"],
  Food: ["#food", "#foodie", "#recipe", "#cooking", "#yummy", "#foodporn"],
  Travel: ["#travel", "#wanderlust", "#explore", "#adventure", "#travelgram", "#vacation"],
  Gaming: ["#gaming", "#gamer", "#gameplay", "#streamer", "#twitch", "#esports"],
};

const PLATFORM_HASHTAGS = {
  TikTok: ["#fyp", "#foryou", "#viral", "#trending", "#tiktok"],
  Instagram: ["#instagood", "#photooftheday", "#instagram", "#explore", "#reels"],
  YouTube: ["#youtube", "#youtuber", "#subscribe", "#shorts", "#video"],
};

function pickRandom(arr, count = 1) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return count === 1 ? shuffled[0] : shuffled.slice(0, count);
}

function generateTrendScore() {
  // Score between 60-99, weighted toward higher scores
  return Math.round((Math.random() * 0.4 + 0.6) * 100);
}

/**
 * Discover trending topics for a given platform and niche
 * @param {string} platform - TikTok, Instagram, or YouTube
 * @param {string} niche - Fashion, Beauty, Fitness, etc.
 * @param {number} count - Number of trends to return (default 5)
 * @returns {Array} Array of trend objects
 */
export function discoverTrends(platform = "TikTok", niche = "Lifestyle", count = 5) {
  const platformTemplates = TREND_TEMPLATES[platform] || TREND_TEMPLATES.TikTok;
  const nicheHashtags = NICHE_HASHTAGS[niche] || NICHE_HASHTAGS.Lifestyle;
  const platHashtags = PLATFORM_HASHTAGS[platform] || PLATFORM_HASHTAGS.TikTok;

  const trends = [];

  for (let i = 0; i < count; i++) {
    const category = pickRandom(platformTemplates);
    const topic = pickRandom(category.topics);

    // Combine niche + platform hashtags with some randomization
    const hashtags = [
      ...pickRandom(nicheHashtags, 3),
      ...pickRandom(platHashtags, 2),
      `#${topic.toLowerCase().replace(/\s+/g, "")}`,
    ];

    trends.push({
      platform,
      topic: `${topic} — ${niche}`,
      description: `Trending ${category.category} content on ${platform}: "${topic}" tailored for the ${niche.toLowerCase()} niche. This format is currently gaining traction and has high engagement potential.`,
      hashtags,
      trendScore: generateTrendScore(),
      source: `${platform.toLowerCase()}-trends-${Date.now()}`,
      category: category.category,
    });
  }

  // Sort by trend score descending
  trends.sort((a, b) => b.trendScore - a.trendScore);
  return trends;
}

/**
 * Analyze how relevant a trend is for a specific character
 * @param {Object} trend - The trend object
 * @param {Object} character - The character object from DB
 * @returns {Object} Relevance analysis with score and reasoning
 */
export function analyzeTrendRelevance(trend, character) {
  let score = 50; // Base score
  const reasons = [];

  // Check platform match
  if (character.targetPlatforms?.includes(trend.platform)) {
    score += 20;
    reasons.push(`Character targets ${trend.platform}`);
  }

  // Check niche match
  if (trend.topic?.toLowerCase().includes(character.niche?.toLowerCase() || "")) {
    score += 25;
    reasons.push(`Trend matches character niche: ${character.niche}`);
  }

  // Check persona alignment
  const persona = (character.persona || "").toLowerCase();
  const trendDesc = (trend.description || "").toLowerCase();
  const personaKeywords = persona.split(/\s+/).filter((w) => w.length > 4);
  const matches = personaKeywords.filter((kw) => trendDesc.includes(kw));
  if (matches.length > 0) {
    score += matches.length * 5;
    reasons.push(`Persona keywords match: ${matches.join(", ")}`);
  }

  // Cap at 100
  score = Math.min(100, score);

  return {
    relevanceScore: score,
    reasons,
    recommendation: score >= 80 ? "Highly recommended" : score >= 60 ? "Good fit" : "Consider adapting",
  };
}
