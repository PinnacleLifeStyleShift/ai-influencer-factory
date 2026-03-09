// ─── Script Generation Service ───────────────────────────────
// Generates content scripts from trends + character personas.
// Currently template-based. Will integrate AI (GPT/Claude) later.

const HOOKS = {
  funny: [
    "Okay but why does nobody talk about this...",
    "I wasn't supposed to show you this but...",
    "POV: you just discovered the best kept secret in {niche}",
    "Not me doing this at 3am but hear me out...",
    "This is your sign to finally try this",
  ],
  educational: [
    "Here's what nobody tells you about {topic}...",
    "Stop doing this wrong — here's the correct way",
    "3 things I wish I knew sooner about {niche}",
    "The science behind why this actually works",
    "Most people don't know this trick for {topic}",
  ],
  dramatic: [
    "I can't believe this actually happened...",
    "Wait for the transformation at the end",
    "This completely changed my perspective on {topic}",
    "You won't believe the difference this makes",
    "The moment everything changed for me",
  ],
  inspirational: [
    "Your daily reminder that you're capable of anything",
    "How I went from struggling to thriving in {niche}",
    "This is what consistency really looks like",
    "The journey nobody sees behind the scenes",
    "If I can do this, so can you — here's how",
  ],
  casual: [
    "Come hang out with me while I {topic}",
    "Just a normal day doing {niche} things",
    "Let's talk about something real for a sec",
    "Rating this trending {topic} — honest thoughts",
    "Grab your coffee, we need to discuss {topic}",
  ],
};

const BODY_TEMPLATES = {
  tutorial: {
    structure: "Step-by-step walkthrough showing the process",
    template:
      "Step 1: {step1}\nStep 2: {step2}\nStep 3: {step3}\n\nPro tip: {tip}\n\nThe key thing to remember is {keyTakeaway}.",
  },
  story: {
    structure: "Personal narrative with a twist or lesson",
    template:
      "So here's what happened — {setup}.\n\nI thought {expectation}, but then {twist}.\n\nThe lesson? {lesson}.\n\nAnd now {resolution}.",
  },
  challenge: {
    structure: "Challenge attempt with reactions",
    template:
      "Taking on the {topic} challenge!\n\nRules: {rules}\n\nAttempt 1: {attempt1}\nAttempt 2: {attempt2}\n\nFinal result: {result}",
  },
  review: {
    structure: "Honest product/trend review with rating",
    template:
      "Testing out {topic} — let's see if it lives up to the hype.\n\nFirst impressions: {firstImpression}\nAfter trying it: {afterTrying}\n\nFinal verdict: {verdict}\nRating: {rating}/10",
  },
  dayInLife: {
    structure: "Follow-along daily content",
    template:
      "Morning: {morning}\nMidday: {midday}\nAfternoon: {afternoon}\nEvening: {evening}\n\nHighlight of the day: {highlight}",
  },
};

const CTAS = {
  TikTok: [
    "Follow for more {niche} content!",
    "Like if you agree! Part 2?",
    "Save this for later — you'll need it!",
    "Drop a comment if you want the full tutorial",
    "Share this with someone who needs to see it!",
  ],
  Instagram: [
    "Save this post for your next {niche} inspo!",
    "Double tap if this resonates with you",
    "Tag someone who needs to see this!",
    "Link in bio for the full guide",
    "What do you think? Tell me in the comments!",
  ],
  YouTube: [
    "Subscribe for weekly {niche} content!",
    "Like this video if you found it helpful!",
    "Check the description for all the links mentioned",
    "What should I cover next? Comment below!",
    "Hit the bell to never miss an upload!",
  ],
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fillTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value || key);
  }
  return result;
}

/**
 * Generate a content script from a trend and character
 * @param {Object} trend - Trend object with topic, platform, etc.
 * @param {Object} character - Character object from DB
 * @param {Object} options - { platform, duration, tone, contentType }
 * @returns {Object} Script with title, hook, body, callToAction
 */
export function generateScript(trend, character, options = {}) {
  const platform = options.platform || trend.platform || "TikTok";
  const duration = options.duration || "30s";
  const tone = options.tone || "casual";
  const contentType = options.contentType || "tutorial";
  const niche = character?.niche || "Lifestyle";
  const persona = character?.persona || "";
  const topic = trend?.topic || "trending content";

  // Pick hook
  const hookTemplates = HOOKS[tone] || HOOKS.casual;
  const hook = fillTemplate(pickRandom(hookTemplates), { topic, niche });

  // Pick body template
  const bodyTemplate = BODY_TEMPLATES[contentType] || BODY_TEMPLATES.tutorial;
  const bodyVars = generateBodyVars(contentType, topic, niche, persona);
  const body = fillTemplate(bodyTemplate.template, bodyVars);

  // Pick CTA
  const ctaTemplates = CTAS[platform] || CTAS.TikTok;
  const callToAction = fillTemplate(pickRandom(ctaTemplates), { niche });

  // Generate title
  const title = generateTitle(topic, contentType, platform);

  // Duration guidance
  const durationGuide = {
    "15s": "Quick-hit content. Keep it punchy — hook + 1 key point + CTA.",
    "30s": "Standard short-form. Hook + 2-3 key points + CTA.",
    "60s": "Extended short-form. Full story arc: hook + setup + payoff + CTA.",
  };

  return {
    title,
    hook,
    body,
    callToAction,
    platform,
    duration,
    tone,
    contentType: bodyTemplate.structure,
    durationGuidance: durationGuide[duration] || durationGuide["30s"],
    characterNotes: persona
      ? `Deliver in character as: ${persona.substring(0, 150)}`
      : "Use authentic, relatable delivery",
  };
}

function generateTitle(topic, contentType, platform) {
  const prefixes = {
    tutorial: ["How to", "The Ultimate Guide to", "Master"],
    story: ["My Experience with", "The Truth About", "Why I"],
    challenge: ["I Tried the", "Taking On the", "Can I Do the"],
    review: ["Honest Review:", "Testing", "Is It Worth It?"],
    dayInLife: ["A Day in My Life:", "Come With Me:", "Daily"],
  };
  const prefix = pickRandom(prefixes[contentType] || prefixes.tutorial);
  const cleanTopic = topic.split(" — ")[0]; // Remove niche suffix
  return `${prefix} ${cleanTopic} | ${platform}`;
}

function generateBodyVars(contentType, topic, niche, persona) {
  const cleanTopic = topic.split(" — ")[0];
  const base = { topic: cleanTopic, niche };

  switch (contentType) {
    case "tutorial":
      return {
        ...base,
        step1: `Start with the basics of ${cleanTopic.toLowerCase()}`,
        step2: `Apply the main technique that makes this work`,
        step3: `Fine-tune and add your personal touch`,
        tip: `Consistency is key — practice this daily for best results`,
        keyTakeaway: `once you nail this technique, everything in ${niche.toLowerCase()} becomes easier`,
      };
    case "story":
      return {
        ...base,
        setup: `I was scrolling through ${niche.toLowerCase()} content when I found this ${cleanTopic.toLowerCase()} trend`,
        expectation: `it would be just another passing trend`,
        twist: `it completely changed how I approach my content`,
        lesson: `Sometimes the trends you dismiss are the ones worth trying`,
        resolution: `I use this technique in almost every post`,
      };
    case "challenge":
      return {
        ...base,
        rules: `Complete the ${cleanTopic.toLowerCase()} in under ${niche === "Fitness" ? "5 minutes" : "one take"}`,
        attempt1: `Started strong but missed a key detail`,
        attempt2: `Nailed it with a twist nobody expected`,
        result: `Way better than I thought — definitely recommend trying this!`,
      };
    case "review":
      return {
        ...base,
        firstImpression: `The packaging and presentation looked promising`,
        afterTrying: `Actually surprised by the quality and results`,
        verdict: `Worth trying if you're into ${niche.toLowerCase()}`,
        rating: `${Math.floor(Math.random() * 3) + 7}`,
      };
    case "dayInLife":
      return {
        ...base,
        morning: `Started the day with a ${niche.toLowerCase()} routine`,
        midday: `Worked on creating content around ${cleanTopic.toLowerCase()}`,
        afternoon: `Met up with some creator friends for a collab`,
        evening: `Wrapped up with editing and planning tomorrow's content`,
        highlight: `The ${cleanTopic.toLowerCase()} content turned out amazing!`,
      };
    default:
      return base;
  }
}
