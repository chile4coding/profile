import { Request, Response } from "express";
import axios from "axios";
import prisma from "../services/db";
import { TokenService } from "../services/token";
import crypto from "crypto";

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
  type: string;
}

export interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: "public" | "private" | null;
}

// PKCE helpers
export function generateRandomString(length: number): string {
  return crypto.randomBytes(length).toString("base64url");
}

export async function sha256(plain: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(hash).toString("base64url");
}

export function generateCodeChallenge(codeVerifier: string): Promise<string> {
  return sha256(codeVerifier);
}

// GitHub OAuth redirect
export async function githubOAuthRedirect(req: Request, res: Response) {
  const { redirect_uri } = req.query as { redirect_uri?: string };

  try {
    const state = generateRandomString(32);
    const codeVerifier = generateRandomString(64);
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Store PKCE data in session for later validation
    req.session.pkceData = {
      state,
      codeVerifier,
      timestamp: Date.now(),
      redirectUri: redirect_uri || null,
    };

    const url =
      `https://github.com/login/oauth/authorize?` +
      `client_id=${CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(CALLBACK_URL || "")}` +
      `&state=${state}` +
      `&code_challenge=${codeChallenge}` +
      `&code_challenge_method=S256` +
      `&scope=user:email`;

    res.redirect(url);
  } catch (err) {
    console.error("GitHub OAuth redirect error:", err);
    res
      .status(500)
      .json({ status: "error", message: "Failed to initiate OAuth flow" });
  }
}

export async function githubOAuthCallback(req: Request, res: Response) {
  try {
    const { code, state } = req.query as { code?: string; state?: string };

    if (!code || !state) {
      return res.status(400).json({
        status: "error",
        message: "Missing code or state parameter",
      });
    }

    const storedPkceData = req.session.pkceData;

    console.log("this is the stored data  === ", storedPkceData);

    if (!storedPkceData || storedPkceData.state !== state) {
      return res.status(400).json({
        status: "error",
        message: "Invalid state parameter",
      });
    }

    const now = Date.now();
    const pkceAge = now - storedPkceData.timestamp;
    const MAX_PKCE_AGE = 5 * 60 * 1000;
    if (pkceAge > MAX_PKCE_AGE) {
      req.session.pkceData = undefined;
      return res.status(400).json({
        status: "error",
        message: "OAuth flow expired. Please try again",
      });
    }

    const codeVerifier = storedPkceData.codeVerifier;
    const redirectUri = storedPkceData.redirectUri; // ← Retrieve stored redirect_uri

    // Exchange code for tokens
    const tokenResponse = await axios.post(
      "https://github.com/login/oauth/access_token",
      {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: CALLBACK_URL,
        state,
        code_verifier: codeVerifier,
      },
      { headers: { Accept: "application/json" } },
    );

    const { access_token: githubAccessToken } = tokenResponse.data;

    if (!githubAccessToken) {
      throw new Error("Failed to obtain GitHub access token");
    }

    // Get user info from GitHub (same as before)
    const [userResponse, emailsResponse] = await Promise.all([
      axios.get<GitHubUser>("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${githubAccessToken}` },
      }),
      axios.get<GitHubEmail[]>("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${githubAccessToken}` },
      }),
    ]);

    const githubUser = userResponse.data;
    const primaryEmail =
      emailsResponse.data.find((e) => e.primary)?.email || githubUser.email;

    if (!primaryEmail) {
      throw new Error("No email found on GitHub account.");
    }

    // Find or create user (same as before)
    let user = await prisma.user.findUnique({
      where: { githubId: String(githubUser.id) },
    });

    if (!user) {
      const existingUser = await prisma.user.findFirst({
        where: { email: primaryEmail },
      });

      if (existingUser) {
        user = await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            githubId: String(githubUser.id),
            username: githubUser.login,
            avatarUrl: githubUser.avatar_url,
            lastLoginAt: new Date(),
          },
        });
      } else {
        user = await prisma.user.create({
          data: {
            githubId: String(githubUser.id),
            username: githubUser.login,
            email: primaryEmail,
            avatarUrl: githubUser.avatar_url,
            role: "analyst",
            isActive: true,
            lastLoginAt: new Date(),
          },
        });
      }
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          username: githubUser.login,
          email: primaryEmail,
          avatarUrl: githubUser.avatar_url,
          lastLoginAt: new Date(),
        },
      });
    }

    // Generate JWT tokens
    const tokenPair = await TokenService.createTokenPair({
      id: user.id,
      role: user.role,
    });

    // Clean up session
    req.session.pkceData = undefined;

    // ── CLI FLOW: redirect to localhost with tokens in URL ──
    if (redirectUri) {
      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.set("access_token", tokenPair.accessToken);
      redirectUrl.searchParams.set("refresh_token", tokenPair.refreshToken);
      // Optional: include user info
      redirectUrl.searchParams.set("username", user.username);
      redirectUrl.searchParams.set("role", user.role);

      return res.redirect(redirectUrl.toString());
    }

    // ── WEB FLOW: set cookies (existing behavior) ──
    res.cookie("access_token", tokenPair.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 3 * 60 * 1000,
    });

    res.cookie("refresh_token", tokenPair.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 5 * 60 * 1000,
    });

    return res.redirect(`${FRONTEND_URL}/dashboard`);
  } catch (err: any) {
    console.error("GitHub OAuth callback error:", err.message);
    req.session.pkceData = undefined;
    return res.status(500).json({
      status: "error",
      message: "Authentication failed: " + err.message,
    });
  }
}
// Refresh access token
// Supports both JSON body (API/CLI) and cookie (web) for refresh token
export async function refreshToken(req: Request, res: Response) {
  try {
    let refresh_token: string | undefined;

    // Try to get refresh token from request body (API/CLI)
    const bodyToken = (req.body as any)?.refresh_token;
    if (bodyToken) {
      refresh_token = bodyToken;
    }

    // Fallback to refresh_token cookie (web flow)
    if (!refresh_token && req.cookies) {
      refresh_token = req.cookies["refresh_token"];
    }

    if (!refresh_token) {
      return res.status(400).json({
        status: "error",
        message: "Refresh token is required",
      });
    }

    // Validate refresh token in database
    const session = await TokenService.validateRefreshToken(refresh_token);
    if (!session) {
      return res.status(403).json({
        status: "error",
        message: "Invalid or expired refresh token",
      });
    }

    // Get user
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
    });
    if (!user || !user.isActive) {
      return res.status(403).json({
        status: "error",
        message: "User inactive or not found",
      });
    }

    // Check if refresh token is expired
    if (session.expiresAt < new Date()) {
      await prisma.session.delete({ where: { refreshToken: refresh_token } });
      return res.status(403).json({
        status: "error",
        message: "Refresh token expired",
      });
    }

    // Rotate tokens (invalidate old refresh token)
    const newTokenPair = await TokenService.rotateRefreshToken(
      refresh_token,
      user.id,
    );
    if (!newTokenPair) {
      return res.status(500).json({
        status: "error",
        message: "Failed to rotate tokens",
      });
    }

    // For web flow: set new cookies
    // Check if this is a web request (has cookies) vs API request
    if (req.cookies && req.cookies["refresh_token"]) {
      // Set new HTTP-only cookies
      res.cookie("access_token", newTokenPair.accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 3 * 60 * 1000, // 3 minutes
      });

      res.cookie("refresh_token", newTokenPair.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 5 * 60 * 1000, // 5 minutes
      });

      return res.json({
        status: "success",
        message: "Tokens refreshed",
      });
    }

    // For API/CLI flow: return tokens in response body
    return res.json({
      status: "success",
      data: {
        access_token: newTokenPair.accessToken,
        refresh_token: newTokenPair.refreshToken,
      },
    });
  } catch (err: any) {
    console.error("Token refresh error:", err);
    return res.status(500).json({
      status: "error",
      message: "Token refresh failed",
    });
  }
}

// Logout - supports both cookie-based (web) and header-based (API/CLI) logout
export async function logout(req: Request, res: Response) {
  try {
    let refreshToken: string | undefined;

    // Try to get refresh token from Authorization header (API/CLI)
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      refreshToken = authHeader.split(" ")[1];
    }

    // Fallback to refresh_token cookie (web flow)
    if (!refreshToken && req.cookies) {
      refreshToken = req.cookies["refresh_token"];
    }

    // Revoke session in database if refresh token exists
    if (refreshToken) {
      await prisma.session.deleteMany({ where: { refreshToken } });
    }

    // Always clear cookies (web flow)
    res.clearCookie("access_token");
    res.clearCookie("refresh_token");

    // API/CLI flow: return JSON response
    return res.json({ status: "success", message: "Logged out successfully" });
  } catch (err) {
    console.error("Logout error:", err);
    return res.status(500).json({ status: "error", message: "Logout failed" });
  }
}

// Get current user
export async function getCurrentUser(req: Request, res: Response) {
  try {
    // This endpoint is protected by authenticateSession middleware
    // req.user is already set
    const user = await prisma.user.findUnique({
      where: { id: (req as any).user?.userId },
      select: {
        id: true,
        githubId: true,
        username: true,
        email: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res
        .status(404)
        .json({ status: "error", message: "User not found" });
    }

    return res.json({
      status: "success",
      data: {
        id: user.id,
        githubId: user.githubId,
        username: user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
        role: user.role,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      },
    });
  } catch (err) {
    console.error("Get current user error:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to get user info" });
  }
}
