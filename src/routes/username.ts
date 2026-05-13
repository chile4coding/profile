import { Request, Response } from "express";
import prisma from "../config/db";
import redis from "../utils/cache";

const RESERVED_WORDS = ["api", "admin", "search", "login", "signup", "help", "about"];
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 30;
const RESERVATION_TTL = 600; // 10 minutes

/**
 * Validate username according to business rules
 * - Length: 3 to 30 characters
 * - Characters: alphanumeric and hyphens only
 * - Hyphens: cannot be leading or trailing
 * - Reserved words blocked
 */
function validateUsername(username: string): { valid: false; error: string } | { valid: true } {
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    return { valid: false, error: `Username must be between ${USERNAME_MIN_LENGTH} and ${USERNAME_MAX_LENGTH} characters` };
  }

  // Allow only alphanumeric and hyphens
  if (!/^[a-zA-Z0-9-]+$/.test(username)) {
    return { valid: false, error: "Username can only contain letters, numbers, and hyphens" };
  }

  // Hyphens cannot be leading or trailing
  if (username.startsWith("-") || username.endsWith("-")) {
    return { valid: false, error: "Username cannot start or end with a hyphen" };
  }

  // Check reserved words (case-insensitive)
  if (RESERVED_WORDS.includes(username.toLowerCase())) {
    return { valid: false, error: "This username is reserved" };
  }

  return { valid: true };
}

/**
 * POST /username/check
 * Flow 1: Check username availability with Redis cache-first strategy
 *
 * Step 1: Validation (synchronous)
 * Step 2: Redis lookup (cache-first)
 * Step 3: PostgreSQL lookup (source of truth)
 * Step 4: Write reservation to Redis (atomic NX)
 * Step 5: Response
 */
export async function checkUsername(req: Request, res: Response) {
  const { username } = req.body;

  // Step 1: Validation
  if (!username || typeof username !== "string") {
    return res.status(400).json({
      status: "error",
      message: "Username is required",
    });
  }

  const validation = validateUsername(username);
  if (!validation.valid) {
    return res.status(400).json({
      status: "error",
      message: validation.error,
    });
  }

  const redisKey = `username:reserve:${username}`;

  try {
    // Step 2: Redis lookup (cache-first)
    const redisValue = await redis.get(redisKey);

    if (redisValue !== null) {
      // Cache hit: name is reserved or taken
      return res.status(409).json({
        status: "error",
        message: "Username is unavailable",
        code: "USERNAME_TAKEN",
      });
    }

    // Step 3: PostgreSQL lookup (source of truth)
    const existingUser = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });

    if (existingUser) {
      // Username permanently taken in database
      return res.status(409).json({
        status: "error",
        message: "Username is unavailable",
        code: "USERNAME_TAKEN",
      });
    }

    // Step 4: Write reservation to Redis (atomic)
    // Generate a temporary reservation ID (random UUID-like string)
    const reservationId = `res_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

    const setResult = await redis.set(redisKey, reservationId, "EX", RESERVATION_TTL, "NX");

    if (!setResult) {
      // SET returned nil (NX=0): concurrent request won the race
      return res.status(409).json({
        status: "error",
        message: "Username was just reserved by another user",
        code: "CONCURRENT_RESERVATION",
      });
    }

    // Step 5: Response — reservation held successfully
    return res.status(200).json({
      status: "success",
      available: true,
      expiresIn: RESERVATION_TTL,
      reservationId,
    });
  } catch (error) {
    console.error("Error in checkUsername:", error);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
}
