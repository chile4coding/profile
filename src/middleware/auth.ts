import { Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import prisma from "../services/db";
import type { CookieParseOptions } from "cookie-parser";

const JWT_SECRET =
  process.env.JWT_SECRET || "your-256-bit-secret-change-this-in-production";

export interface AuthRequest extends Request {
  user?: {
    userId: string;
    role: string;
  };
  cookies: {
    [key: string]: string | undefined;
  };
}

// Session-based authentication (validates that user has an active session in database)
// Supports both cookie-based (web) and header-based (API/CLI) authentication
export async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    let token: string | undefined;

    // Check for bearer token in Authorization header first (API/CLI clients)
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    }

    // If no header token, check for access_token cookie (web browser flow)
    if (!token && req.cookies) {
      token = req.cookies["access_token"];
    }
    if (!token) {
      return res
        .status(401)
        .json({ status: "error", message: "Authentication required" });
    }

    // Verify JWT token
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload & {
      userId: string;
      type: string;
    };

    if (decoded.type !== "access") {
      return res
        .status(403)
        .json({ status: "error", message: "Invalid token type" });
    }

    // Check if user exists and is active
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) {
      return res
        .status(403)
        .json({ status: "error", message: "User inactive or not found" });
    }

    // Validate active session exists (unexpired refresh token)
    // This ensures the access token hasn't been revoked via logout or token rotation
    const validSession = await prisma.session.findFirst({
      where: {
        userId: user.id,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });

    if (!validSession) {
      return res.status(403).json({
        status: "error",
        message: "Session expired. Please log in again.",
      });
    }

    req.user = {
      userId: user.id,
      role: user.role,
    };

    next();
  } catch (err) {
    console.log(err);
    return res
      .status(403)
      .json({ status: "error", message: "Invalid or expired token" });
  }
}
