import { Router } from "express";
import { getDashboardStats } from "../controllers/dashboardController";
import { requireApiVersion } from "../middleware/version";
import { authorizeRole } from "../middleware/rbac";
import { apiLimiter } from "../middleware/rateLimit";
import { authenticate } from "../middleware/auth";

const router = Router();

// Dashboard routes require authentication and appropriate role

// GET /api/dashboard/stats - Get dashboard statistics
router.get(
  "/dashboard/stats",
  apiLimiter,
  requireApiVersion,
  authenticate,
  authorizeRole("admin", "analyst"),
  getDashboardStats,
);

export default router;
