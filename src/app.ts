import express, { Request, Response, NextFunction } from "express";

import cookieParser from "cookie-parser";

import "dotenv/config";

import { checkUsername } from "./routes/username";

const app = express();


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


// Username availability check
app.post("/username/check", checkUsername);

app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok" });
});




export default app;
