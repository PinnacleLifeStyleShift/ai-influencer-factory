import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  // Clear existing data
  await prisma.campaignSubmission.deleteMany();
  await prisma.content.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.character.deleteMany();

  // ─── Seed Characters ─────────────────────────────────────
  const veronica = await prisma.character.create({
    data: {
      characterId: "INFL-001",
      name: "Veronica X",
      characterType: "Human",
      niche: "Fashion & Beauty",
      persona: "Luxury street-style model with an edge.",
      gender: "Female",
      ethnicity: "Mixed / Hybrid",
      eyeColor: "Purple",
      age: "25",
      advancedFeatures: "Heterochromatic iris",
      optionalPrompt: "Cyberpunk aesthetic, neon-lit environment",
      aspectRatio: "9:16",
      qualitySetting: "4K",
      bopaBackground: "Urban rooftop, neon city",
      bopaOutfit: "Holographic streetwear",
      bopaPoses: "Power stance, looking over shoulder",
      bopaAngles: "Close-up portrait, ¾ body",
      targetPlatforms: ["Instagram", "TikTok"],
      status: "active",
      followerCount: 42300,
      totalViews: 1280000,
      engagementRate: "6.40",
    },
  });

  const lycan = await prisma.character.create({
    data: {
      characterId: "INFL-002",
      name: "Lycan",
      characterType: "Mammal Hybrid",
      niche: "Gaming & Tech",
      persona: "Wolf-human tech reviewer obsessed with future hardware.",
      gender: "Male",
      ethnicity: "European",
      eyeColor: "Green",
      age: "Ageless",
      advancedFeatures: "Wolf ears, fangs, fur markings",
      optionalPrompt: "Wearing futuristic streetwear with holographic accents",
      aspectRatio: "9:16",
      qualitySetting: "4K",
      bopaBackground: "Dark gaming den, RGB lighting",
      bopaOutfit: "Tech streetwear",
      bopaPoses: "Seated lean, pointing at camera",
      bopaAngles: "Close-up portrait, full body",
      targetPlatforms: ["YouTube", "TikTok"],
      status: "active",
      followerCount: 89100,
      totalViews: 3400000,
      engagementRate: "8.20",
    },
  });

  // ─── Seed Content ────────────────────────────────────────
  const today = new Date().toISOString().split("T")[0];
  const in2Days = new Date(Date.now() + 2 * 86400000).toISOString().split("T")[0];

  await prisma.content.createMany({
    data: [
      {
        title: "Monday Fit Drop",
        contentType: "Static Image",
        platform: "Instagram",
        scheduledDate: today,
        status: "scheduled",
        caption: "New look just dropped 🔥",
        hashtags: "#aimodel #fashion",
        characterId: veronica.id,
      },
      {
        title: "RTX 5090 Reaction",
        contentType: "Animated Video",
        platform: "YouTube",
        scheduledDate: in2Days,
        status: "scheduled",
        caption: "My honest reaction to the new GPU...",
        hashtags: "#gaming #tech",
        motionPrompt: "Character turns to look directly at camera, slow dramatic zoom",
        characterId: lycan.id,
      },
    ],
  });

  // ─── Seed Campaigns ──────────────────────────────────────
  const in8Days = new Date(Date.now() + 8 * 86400000).toISOString().split("T")[0];

  await prisma.campaign.create({
    data: {
      name: "Higgsfield Spring Creators",
      brand: "Higgsfield AI",
      platform: "Instagram",
      brief: "Create a 15-second reel showcasing your AI influencer in a lifestyle setting.",
      requirements: "Must include #HiggsfieldEarn. Paid Partnership label required.",
      payoutAmount: "125.00",
      deadline: in8Days,
      status: "active",
    },
  });

  console.log("✅ Seed data created successfully");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
