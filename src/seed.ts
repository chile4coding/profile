const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const path = require("path");

const prisma = new PrismaClient();

async function seed() {
  console.log("Starting seed...");

  const seedFilePath = path.join(__dirname, "seed_profiles.json");
  const seedData = JSON.parse(fs.readFileSync(seedFilePath, "utf-8"));
  const profiles = seedData.profiles;

  console.log(`Found ${profiles.length} profiles to seed.`);

  let successCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const profile of profiles) {
    try {
      await prisma.profile.upsert({
        where: { name: profile.name.toLowerCase().trim() },
        update: {
          gender: profile.gender.toLowerCase(),
          genderProbability: profile.gender_probability,
          age: profile.age,
          ageGroup: profile.age_group.toLowerCase(),
          countryId: profile.country_id.toUpperCase(),
          countryName: profile.country_name,
          countryProbability: profile.country_probability,
        },
        create: {
          name: profile.name.toLowerCase().trim(),
          gender: profile.gender.toLowerCase(),
          genderProbability: profile.gender_probability,
          age: profile.age,
          ageGroup: profile.age_group.toLowerCase(),
          countryId: profile.country_id.toUpperCase(),
          countryName: profile.country_name,
          countryProbability: profile.country_probability,
        },
      });
      successCount++;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Unique constraint")
      ) {
        skippedCount++;
      } else {
        errorCount++;
        console.error(`Error seeding profile ${profile.name}:`, error);
      }
    }
  }

  console.log(
    `Seed complete. Success: ${successCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`,
  );

  const totalProfiles = await prisma.profile.count();
  const totalUsers = await prisma.user.count();
  console.log(`Total users in database: ${totalUsers}`);
  console.log(`Total profiles in database: ${totalProfiles}`);
}

seed()
  .catch((e) => {
    console.error("Seed error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
