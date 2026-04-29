import { Router } from "express";
import {
  githubOAuthRedirect,
  githubOAuthCallback,
  refreshToken,
  logout,
  getTestTokens,
} from "../controllers/authController";
import { authenticate } from "../middleware/auth";
import { authLimiter } from "../middleware/rateLimit";
import { authorizeRole } from "../middleware/rbac";

const router = Router();

router.get("/github", authLimiter, githubOAuthRedirect);
router.get("/github/callback", authLimiter, githubOAuthCallback);
router.post("/refresh", authLimiter, refreshToken);

// Protected auth endpoints

router.post(
  "/logout",

  authLimiter,

  authenticate,
  authorizeRole("admin", "analyst"),
  logout,
);

router.get("/test-tokens", getTestTokens);

export default router;
