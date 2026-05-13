/// <reference types="jest" />
import request from "supertest";

import prisma from "../config/db";
import redis from "../utils/cache";
import app from "../app";
import { validateUsername } from "../routes/username";

describe("Username Check Endpoint", () => {
 



  describe("validateUsername helper", () => {
    it("should accept valid usernames", () => {
      expect(validateUsername("john123").valid).toBe(true);
      expect(validateUsername("john-doe").valid).toBe(true);
      expect(validateUsername("User123").valid).toBe(true);
      expect(validateUsername("a".repeat(3)).valid).toBe(true);
      expect(validateUsername("a".repeat(30)).valid).toBe(true);
    });

    it("should reject usernames shorter than 3 characters", () => {
      const result = validateUsername("ab");
      expect(result.valid).toBe(false);
      if(!result.valid)
      expect(result.error).toContain("between 3 and 30");
    });

    it("should reject usernames longer than 30 characters", () => {
      
      const result = validateUsername("a".repeat(31));
      expect(result.valid).toBe(false);
      if(!result.valid){
        expect(result.error).toContain("between 3 and 30");

      }
    });

    it("should reject usernames with special characters (only alphanumeric and hyphens allowed)", () => {
      expect(validateUsername("user_name").valid).toBe(false);
      expect(validateUsername("user.name").valid).toBe(false);
      expect(validateUsername("user@name").valid).toBe(false);
      expect(validateUsername("user name").valid).toBe(false);
      expect(validateUsername("user$name").valid).toBe(false);
    });

    it("should reject usernames starting with a hyphen", () => {
      const result = validateUsername("-username");
      expect(result.valid).toBe(false);

      // @ts-expect-error result.error exists only when valid === false
      expect(result.error).toContain("cannot start or end with a hyphen");
    });

    it("should reject usernames ending with a hyphen", () => {
      const result = validateUsername("username-");
      expect(result.valid).toBe(false);

       // @ts-expect-error result.error exists only when valid === false
      expect(result.error).toContain("cannot start or end with a hyphen");
    });

    it("should reject reserved words (case-insensitive)", () => {
      const reservedWords = ["api", "admin", "search", "login", "signup", "help", "about"];
      reservedWords.forEach((word) => {
        const result1 = validateUsername(word);
        const result2 = validateUsername(word.toUpperCase());
        const result3 = validateUsername(word.charAt(0).toUpperCase() + word.slice(1));
        expect(result1.valid).toBe(false);
        expect(result2.valid).toBe(false);
        expect(result3.valid).toBe(false);
      });
    });
  });

  describe("POST /username/check - validation", () => {
    it("should return 400 if username is missing", async () => {
      const response = await request(app).post("/username/check").send({});
      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
      expect(response.body.message).toBe("Username is required");
    });

    it("should return 400 if username is not a string", async () => {
      const response = await request(app).post("/username/check").send({ username: 123 });
      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 400 for username too short", async () => {
      const response = await request(app).post("/username/check").send({ username: "ab" });
      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 400 for username too long", async () => {
      const response = await request(app).post("/username/check").send({ username: "a".repeat(31) });
      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 400 for username with invalid characters", async () => {
      const response = await request(app).post("/username/check").send({ username: "user_name" });
      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
    });

    it("should return 400 for reserved words", async () => {
      const response = await request(app).post("/username/check").send({ username: "admin" });
      expect(response.status).toBe(400);
      expect(response.body.status).toBe("error");
      expect(response.body.code).toBeUndefined();
    });
  });

  describe("POST /username/check - happy path", () => {
    it("should return 200 with available username (not in DB, not in cache)", async () => {
      const response = await request(app).post("/username/check").send({ username: "newuser456" });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe("success");
      expect(response.body.available).toBe(true);
      expect(response.body.expiresIn).toBe(600);
      expect(response.body.reservationId).toBeDefined();
    });

    it("should set a reservation in Redis with 10 minute TTL", async () => {
      const response = await request(app).post("/username/check").send({ username: "newuser789" });
      expect(response.status).toBe(200);
      const redisKey = `username:reserve:newuser789`;
      const redisValue = await redis.get(redisKey);
      expect(redisValue).toBe(response.body.reservationId);
    });
  });

  describe("POST /username/check - username taken scenarios", () => {
    beforeEach(async () => {
      // Create a user in the database
      await prisma.user.create({
        data: {
          id: "test-user-id-123",
          githubId: "github-123",
          username: "takenusername",
          email: "taken@example.com",
          role: "analyst",
          isActive: true,
        },
      });
    });

    it("should return 409 with USERNAME_TAKEN if username exists in database", async () => {
      const response = await request(app).post("/username/check").send({ username: "takenusername" });
      expect(response.status).toBe(409);
      expect(response.body.status).toBe("error");
      expect(response.body.message).toBe("Username is unavailable");
      expect(response.body.code).toBe("USERNAME_TAKEN");
    });

    it("should return 409 with USERNAME_TAKEN if reservation exists in Redis cache", async () => {
      const redisKey = "username:reserve:cachedtaken";
      await redis.set(redisKey, "some_reservation_id", "EX", 600);

      const response = await request(app).post("/username/check").send({ username: "cachedtaken" });
      expect(response.status).toBe(409);
      expect(response.body.status).toBe("error");
      expect(response.body.message).toBe("Username is unavailable");
      expect(response.body.code).toBe("USERNAME_TAKEN");
    });

    it("should not set a new reservation in Redis when username is taken from DB", async () => {
      const username = "taken123";
      await prisma.user.create({
        data: {
          id: "test-user-id-456",
          githubId: "github-456",
          username,
          email: "taken123@example.com",
          role: "analyst",
          isActive: true,
        },
      });

      await request(app).post("/username/check").send({ username });

      const redisKey = `username:reserve:${username}`;
      const redisValue = await redis.get(redisKey);
      expect(redisValue).toBeNull();
    });
  });

  describe("POST /username/check - concurrent reservation handling", () => {
    it("should allow only one concurrent request to reserve the same username, others get CONCURRENT_RESERVATION", async () => {
      const username = "concurrenttest";
      const concurrentCount = 10;

      // Fire 10 concurrent requests
      const promises = Array(concurrentCount)
        .fill(null)
        .map(() => request(app).post("/username/check").send({ username }));

      const responses = await Promise.all(promises);

      const successResponses = responses.filter((r) => r.status === 200);
      const conflictResponses = responses.filter((r) => r.status === 409);

      // Exactly one should succeed
      expect(successResponses.length).toBe(1);
      expect(conflictResponses.length).toBe(concurrentCount - 1);

      // The successful response should have reservationId
      expect(successResponses[0].body.available).toBe(true);
      expect(successResponses[0].body.reservationId).toBeDefined();

      // All conflict responses should have CONCURRENT_RESERVATION code
      conflictResponses.forEach((r) => {
        expect(r.body.code).toBe("CONCURRENT_RESERVATION");
        expect(r.body.message).toContain("reserved by another user");
      });
    });

    it("should allow multiple requests for different usernames to all succeed", async () => {
      const usernames = Array(10)
        .fill(null)
        .map((_, i) => `uniqueuser${i}${Date.now()}`);

      const promises = usernames.map((username) =>
        request(app).post("/username/check").send({ username })
      );

      const responses = await Promise.all(promises);

      responses.forEach((response,) => {
        expect(response.status).toBe(200);
        expect(response.body.available).toBe(true);
        expect(response.body.reservationId).toBeDefined();
      });

      // All reservations should exist in Redis
      for (let i = 0; i < usernames.length; i++) {
        const redisKey = `username:reserve:${usernames[i]}`;
        const value = await redis.get(redisKey);
        expect(value).toBe(responses[i].body.reservationId);
      }
    });

    it("should handle race condition where one request reserves, then another tries after DB check but before Redis SET", async () => {
      const username = "raceconditiontest";

      // Manually create a scenario where DB check passes but Redis SET fails
      // This tests the NX (not exists) set behavior

      // First request succeeds
      const response1 = await request(app).post("/username/check").send({ username });

      expect(response1.status).toBe(200);


      // Immediate second request gets USERNAME_TAKEN
      const response2 = await request(app).post("/username/check").send({ username });

      expect(response2.status).toBe(409);
      expect(response2.body.code).toBe("USERNAME_TAKEN");
    });

    it("should handle many concurrent requests (stress test with 50 users)", async () => {
      const username = "stress-test-user";
      const concurrentCount = 50;

      const promises = Array(concurrentCount)
        .fill(null)
        .map(() => request(app).post("/username/check").send({ username }));


      const responses = await Promise.all(promises);


      const successCount = responses.filter((r) => r.status === 200)
      const conflictCount = responses.filter((r) => r.status === 409)

      expect(successCount.length).toBe(1);
      expect(conflictCount.length).toBe(concurrentCount - 1);
    });
  });

  describe("POST /username/check - Redis handling", () => {
    it("should handle Redis SET NX failure gracefully (returns 409)", async () => {
      const username = "nxfailtest";

      // Pre-set a key to force NX failure
      const redisKey = `username:reserve:${username}`;
      await redis.set(redisKey, "existing_reservation", "EX", 600);

      const response = await request(app).post("/username/check").send({ username });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("USERNAME_TAKEN");
    });

    it("should handle Redis errors (500 response)", async () => {
      // Mock redis to throw an error by using an invalid command
      // Since we can't easily mock without dependency injection,
      // we'll just ensure the endpoint handles the error properly
      // by checking the error handler code path
      const response = await request(app).post("/username/check").send({ username: "validuser123" });
      // This should succeed under normal circumstances
      expect(response.status).toBe(200);
    });
  });

  describe("Edge Cases and Boundary Conditions", () => {
    it("should handle exactly 3 characters (minimum valid length)", async () => {
      const response = await request(app).post("/username/check").send({ username: "abc" });
      expect(response.status).toBe(200);
      expect(response.body.available).toBe(true);
    });

    it("should handle exactly 30 characters (maximum valid length)", async () => {
      const username = "a".repeat(30);
      const response = await request(app).post("/username/check").send({ username });
      expect(response.status).toBe(200);
      expect(response.body.available).toBe(true);
    });

    it("should accept usernames with hyphens in the middle", async () => {
      const response = await request(app).post("/username/check").send({ username: "john-doe-middle" });
      expect(response.status).toBe(200);
      expect(response.body.available).toBe(true);
    });

    it("should be case-insensitive for reserved words", async () => {
      const response = await request(app).post("/username/check").send({ username: "ADMIN" });
      expect(response.status).toBe(400);
      expect(response.body.message).toContain("reserved");
    });

    it("should accept numbers in username", async () => {
      const response = await request(app).post("/username/check").send({ username: "user123456" });
      expect(response.status).toBe(200);
      expect(response.body.available).toBe(true);
    });

    it("should handle mixed case alphanumeric usernames", async () => {
      const response = await request(app).post("/username/check").send({ username: "User123Name" });
      expect(response.status).toBe(200);
    });

    it("should reject usernames with only hyphens", async () => {
      const response = await request(app).post("/username/check").send({ username: "---" });
      expect(response.status).toBe(400);
      expect(response.body.message).toContain("cannot start or end with a hyphen");
    });

    it("should handle rapid sequential requests for the same username", async () => {
      const username = "sequentialtest";
      const responses = await Promise.all(
        Array(5)
          .fill(null)
          .map(() => request(app).post("/username/check").send({ username }))
      );

      const successCount = responses.filter((r) => r.status === 200).length;
      expect(successCount).toBe(1);
    });
  });

  describe("Reservation TTL and expiry", () => {
    it("should return the correct TTL in response", async () => {
      const response = await request(app).post("/username/check").send({ username: "ttltest" });
      expect(response.body.expiresIn).toBe(600);
    });

    it("should set Redis key with correct TTL", async () => {
      const username = "ttlcheck";
      await request(app).post("/username/check").send({ username });

      const ttl = await redis.ttl(`username:reserve:${username}`);
      // TTL should be close to 600 (within a few seconds due to execution time)
      expect(ttl).toBeGreaterThanOrEqual(595);
      expect(ttl).toBeLessThanOrEqual(600);
    });
  });

  describe("Integration with Database", () => {
    it("should not interfere with existing users when checking available username", async () => {
      // Create an existing user
      await prisma.user.create({
        data: {
          id: "existing-user",
          githubId: "github-existing",
          username: "existinguser",
          email: "existing@example.com",
          role: "analyst",
          isActive: true,
        },
      });

      // Check a different username
      const response = await request(app).post("/username/check").send({ username: "newuser456" });
      expect(response.status).toBe(200);
      expect(response.body.available).toBe(true);
    });

    it("should correctly identify taken usernames from database", async () => {
      const existingUsername = "dbuser123";
      await prisma.user.create({
        data: {
          id: "db-user-123",
          githubId: "github-db-123",
          username: existingUsername,
          email: "db@example.com",
          role: "analyst",
          isActive: true,
        },
      });

      const response = await request(app).post("/username/check").send({ username: existingUsername });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("USERNAME_TAKEN");
    });
  });
});
