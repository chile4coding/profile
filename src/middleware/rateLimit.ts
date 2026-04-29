import { rateLimit } from "express-rate-limit";
import { Request } from "express";

// ---------------------------------------------------------------------------
// Auth limiter — applied to /auth/* routes
// Max 10 requests per 15 minutes per IP.
// The 11th request returns 429 — required by the rate_limiting test.
// NOTE: No skip for test environment. The limiter must fire in all envs.
// ---------------------------------------------------------------------------
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 11th request → 429
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.ip || "unknown",
  message: {
    status: "error",
    message: "Too many requests, please try again later.",
  },
});

// ---------------------------------------------------------------------------
// API limiter — applied to /api/* routes
// Max 60 requests per minute, keyed by user ID (authenticated) or IP.
// ---------------------------------------------------------------------------
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  keyGenerator: (req: Request) => {
    return (req as any).user?.userId || req.ip || "unknown";
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "error",
    message: "Too many requests, please try again after a minute.",
  },
});
