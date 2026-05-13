import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

interface ProfileData {
  name: string;
  gender: string;
  gender_probability: number;
  age: number;
  age_group: string;
  country_id: string;
  country_name: string;
  country_probability: number;
}

// Generate a valid unique username from a profile name
async function generateUniqueUsername(
  baseName: string,
  existingUsernames: Set<string>
): Promise<string> {
  // Normalize: lowercase, trim, replace spaces/special chars with hyphens
  let slug = baseName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, ""); // remove leading/trailing hyphens

  // Ensure at least 3 characters, pad with random suffix if needed
  if (slug.length < 3) {
    slug = `user-${slug.padStart(3, "x")}`;
  }

  // Truncate to 25 chars to leave room for numeric suffix
  if (slug.length > 25) {
    slug = slug.substring(0, 25).replace(/-+$/, "");
  }

  const baseSlug = slug;
  let counter = 0;
  let username = slug;

  // Ensure uniqueness and adherence to rules
  while (
    existingUsernames.has(username) ||
    username.length < 3 ||
    username.length > 30 ||
    /^-|-$/.test(username) ||
    !/^[a-z0-9-]+$/.test(username)
  ) {
    counter++;
    const suffix = counter > 1 ? `-${counter}` : "";
    username = baseSlug.substring(0, 30 - suffix.length) + suffix;
  }

  existingUsernames.add(username);
  return username;
}

async function seed() {
  console.log("Starting seed...");

  // Create default users (admin/analyst)
  console.log("Creating default users...");
  const adminUser = await prisma.user.upsert({
    where: { githubId: "1" },
    update: {},
    create: {
      githubId: "1",
      username: "admin",
      email: "admin@insighta.com",
      avatarUrl: "https://github.com/admin.png",
      role: "admin",
      isActive: true,
      lastLoginAt: new Date(),
    },
  });

  const analystUser = await prisma.user.upsert({
    where: { githubId: "2" },
    update: {},
    create: {
      githubId: "2",
      username: "analyst",
      email: "analyst@insighta.com",
      avatarUrl: "https://github.com/analyst.png",
      role: "analyst",
      isActive: true,
      lastLoginAt: new Date(),
    },
  });

  console.log(
    `Created admin user: ${adminUser.username} (role: ${adminUser.role})`,
  );
  console.log(
    `Created analyst user: ${analystUser.username} (role: ${analystUser.role})`,
  );

  // Seed profiles — each gets its own user with unique username
  const seedFilePath = path.join(__dirname, "seed_profiles.json");
  const seedData = JSON.parse(fs.readFileSync(seedFilePath, "utf-8"));
  const profiles: ProfileData[] = seedData.profiles;

  console.log(`Found ${profiles.length} profiles to seed.`);

  // Pre-fetch existing usernames to avoid conflicts
  const existingUsers = await prisma.user.findMany({
    select: { username: true },
  });
  const usedUsernames:Set<string> = new Set(existingUsers.map((u:any) => u.username)) ;

  let userSuccessCount = 0;
  let profileSuccessCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const profile of profiles) {
    try {
      // Generate a unique username from the profile name
      const username = await generateUniqueUsername(profile.name, usedUsernames);
      const email = `${username}@example.com`;
      // Use a deterministic pseudo-githubId for seeded users
      const githubId = `seed-${username}`;

      // Create a new user for this profile
      const user = await prisma.user.create({
        data: {
          githubId,
          username,
          email,
          role: "analyst",
          isActive: true,
        },
      });

      userSuccessCount++;

      // Create or update the profile linked to this user
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
          userId: user.id,
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
          userId: user.id,
        },
      });
      profileSuccessCount++;

      console.log(`  Created user '${username}' → profile '${profile.name}'`);
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
    `Seed complete. Users created: ${userSuccessCount}, Profiles updated/created: ${profileSuccessCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`,
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
