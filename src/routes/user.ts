import { Router } from "express";
import { getCurrentUser } from "../controllers/userControllers";
import { authenticate } from "../middleware/auth";
import { authorizeRole } from "../middleware/rbac";
import { requireApiVersion } from "../middleware/version";
import { apiLimiter } from "../middleware/rateLimit";

const router = Router();

router.get(
  "/me",
  apiLimiter,
  requireApiVersion,
  authenticate,
  authorizeRole("admin", "analyst"),
  getCurrentUser,
);

export default router;
