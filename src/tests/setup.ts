import prisma from "../config/db";
import redis from "../utils/cache";

beforeAll(async () => {
 await prisma.$connect();
    // Clear Redis and DB state
    await redis.flushall();
    await prisma.user.deleteMany({});
});

afterAll(async () => {
 await prisma.$disconnect();
    await redis.quit();
});

beforeEach(async () => {
  // Clean up before each test
    await redis.flushall();
    await prisma.user.deleteMany({});
});

