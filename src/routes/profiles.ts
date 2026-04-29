import { Router } from "express";
import {
  createProfile,
  getProfileById,
  getProfiles,
  deleteProfile,
  searchProfiles,
  exportProfiles,
} from "../controllers/profileController";
import { requireApiVersion } from "../middleware/version";
import { authorizeRole } from "../middleware/rbac";
import { apiLimiter } from "../middleware/rateLimit";
import { authenticate } from "../middleware/auth";

const router = Router();

// All profile routes require API version header (except in middleware chain after auth)

router.post(
  "/profiles",

  apiLimiter,
  requireApiVersion,
  authenticate,
  authorizeRole("admin"),

  createProfile,
);
router.get(
  "/profiles",
  apiLimiter,
  requireApiVersion,
  authenticate,
  authorizeRole("admin", "analyst"),
  getProfiles,
);
router.get(
  "/profiles/search",
  apiLimiter,
  requireApiVersion,
  authenticate,
  authorizeRole("admin", "analyst"),
  searchProfiles,
);
router.get(
  "/profiles/export",
  apiLimiter,
  requireApiVersion,
  authenticate,
  authorizeRole("admin", "analyst"),
  exportProfiles,
); // Must come BEFORE /profiles/:id
router.get(
  "/profiles/:id",
  apiLimiter,
  requireApiVersion,
  authenticate,
  authorizeRole("admin", "analyst"),
  getProfileById,
);
router.delete(
  "/profiles/:id",
  apiLimiter,
  requireApiVersion,
  authenticate,
  authorizeRole("admin"),
  deleteProfile,
);

export default router;
