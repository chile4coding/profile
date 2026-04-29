import express, { Request, Response, NextFunction } from "express";
import profileRoutes from "./routes/profiles";
import userRoutes from "./routes/user";

import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import { requestLogger } from "./middleware/logger";
import { apiLimiter, authLimiter } from "./middleware/rateLimit";
import cookieParser from "cookie-parser";
import session from "express-session";
import createPgStore from "connect-pg-simple";
import { Pool } from "pg";
import "dotenv/config";
// Import to register session type augmentation
import "./types/session";

const app = express();

// Create PostgreSQL connection pool for session store
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// PostgreSQL session store configuration
const PgStore = createPgStore(session);

// Session middleware for PKCE state storage (must be before routes)
app.use(
  session({
    store: new (PgStore as any)({
      pool: pgPool,
      tableName: "session",
      // createTable defaults to true - let library auto-create with correct schema
    }),
    secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax" as const,
      maxAge: 5 * 60 * 1000, // 5 minutes - matches OAuth flow timeout
    },
    name: "insighta.sid",
    rolling: false,
  }),
);

app.use(express.json());
app.use(cookieParser());

// CORS configuration
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_URL || "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Version, X-CSRF-Token",
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Request logging
app.use(requestLogger);
app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.use("/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api", profileRoutes);
app.use("/api", dashboardRoutes);

export default app;
