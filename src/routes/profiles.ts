import { Router } from "express";
import {
  createProfile,
  getProfileById,
  getProfiles,
  deleteProfile,
  searchProfiles,
  exportProfiles,
  uploadProfilesCsv,
} from "../controllers/profileController";
import { requireApiVersion } from "../middleware/version";
import { authorizeRole } from "../middleware/rbac";
import { apiLimiter } from "../middleware/rateLimit";
import { authenticate } from "../middleware/auth";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const router = Router();

// Configure multer for file uploads with disk storage
const upload = multer({
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "text/csv" || file.mimetype === "application/csv") {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are allowed"));
    }
  },
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, "uploads/");
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
    }
  })
});

// All profile routes require API version header (except in middleware chain after auth)

router.post(
  "/profiles",
  // apiLimiter,
  // requireApiVersion,
  // authenticate,
  // authorizeRole("admin"),
  createProfile,
);

// CSV upload endpoint
router.post(
  "/profiles/upload",
  // apiLimiter,
  // requireApiVersion,
  // authenticate,
  // authorizeRole("admin"),
  upload.single("file"),
  uploadProfilesCsv,
);

router.get(
  "/profiles",
  // apiLimiter,
  // requireApiVersion,
  // authenticate,
  // authorizeRole("admin", "analyst"),
  getProfiles,
);
router.get(
  "/profiles/search",
  // apiLimiter,
  // requireApiVersion,
  // authenticate,
  // authorizeRole("admin", "analyst"),
  searchProfiles,
);
router.get(
  "/profiles/export",
  // apiLimiter,
  // requireApiVersion,
  // authenticate,
  // authorizeRole("admin", "analyst"),
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
