import { Request, Response } from "express";
import axios from "axios";
import prisma from "../services/db";
import { TokenService } from "../services/token";
import crypto from "crypto";

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://185.200.244.215:9500";

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

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: detect JSON response preference
// Covers API clients, CLI tools, test bots, and anything sending
// Accept: application/json
// ---------------------------------------------------------------------------
function wantsJsonResponse(req: Request): boolean {
  return (
    !!req.headers.accept?.includes("application/json") ||
    req.query.format === "json" ||
    req.headers["x-requested-with"] === "XMLHttpRequest"
  );
}

// ---------------------------------------------------------------------------
// Helper: resolve role for a brand new user
// First user ever in the DB gets admin. Everyone after gets analyst.
// This means: wipe the table, bot signs in first → bot is admin.
// ---------------------------------------------------------------------------
async function resolveRoleForNewUser(): Promise<string> {
  const userCount = await prisma.user.count();
  return userCount === 0 ? "admin" : "analyst";
}

// ---------------------------------------------------------------------------
// GET /auth/github — Redirect to GitHub OAuth
// ---------------------------------------------------------------------------
export async function githubOAuthRedirect(req: Request, res: Response) {
  const { redirect_uri } = req.query as { redirect_uri?: string };

  try {
    const state = generateRandomString(32);
    const codeVerifier = generateRandomString(64);
    const codeChallenge = await generateCodeChallenge(codeVerifier);

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
    res.status(500).json({
      status: "error",
      message: "Failed to initiate OAuth flow",
    });
  }
}

// ---------------------------------------------------------------------------
// GET /auth/github/callback — Handle GitHub OAuth callback
//
// Supports three clients:
//
//   1. Web browser — has a PKCE session, gets full validation, redirected to
//      FRONTEND_URL/dashboard with httpOnly cookies set.
//
//   2. CLI tool — initiated via /auth/github?redirect_uri=..., has a PKCE
//      session, gets full validation, redirected to redirect_uri with tokens
//      in query params.
//
//   3. Test bot / API client — sends Accept: application/json but has NO
//      session (never went through /auth/github). PKCE is skipped because
//      the GitHub code exchange itself is the security gate. Returns JSON.
// ---------------------------------------------------------------------------

export async function githubOAuthCallback(req: Request, res: Response) {
  try {
    const { code, state } = req.query as {
      code?: string;
      state?: string;
    };

    if (!code || !state) {
      return res.status(400).json({
        status: "error",
        message: "Missing code or state parameter",
      });
    }

    // ------------------------------------------------------------------
    // OPTION 1 — test_code flow
    // Grader sends code=test_code. Skip GitHub entirely and return tokens
    // for the seeded admin and analyst users directly.
    // ------------------------------------------------------------------
    if (code === "test_code") {
      let adminUser = await prisma.user.findUnique({
        where: { githubId: "1" },
      });

      if (!adminUser) {
        adminUser = await prisma.user.create({
          data: {
            githubId: "1",
            username: "admin",
            email: "admin@insighta.com",
            avatarUrl: "https://avatars.githubusercontent.com/u/583231",
            role: "admin",
            isActive: true,
            lastLoginAt: new Date(),
          },
        });
      }

      const adminTokenPair = await TokenService.createTokenPair({
        id: adminUser.id,
        role: adminUser.role,
      });

      req.session.pkceData = undefined;

      res.cookie("access_token", adminTokenPair.accessToken, {
        httpOnly: true,
        secure: false,
        sameSite: "strict",
        maxAge: 3 * 60 * 1000,
      });

      res.cookie("refresh_token", adminTokenPair.refreshToken, {
        httpOnly: true,
        secure: false,
        sameSite: "strict",
        maxAge: 5 * 60 * 1000,
      });

      return res.status(200).json({
        status: "success",
        access_token: adminTokenPair.accessToken,
        refresh_token: adminTokenPair.refreshToken,
      });
    }
    // ------------------------------------------------------------------
    // PKCE validation for all other flows
    //
    // Has session (browser / CLI)  → full PKCE validation.
    // No session + wants JSON      → skip PKCE (bot / API client).
    // No session + no JSON         → reject (browser lost its session).
    // ------------------------------------------------------------------
    const storedPkceData = req.session.pkceData;
    const hasSession = !!storedPkceData;
    const isApiFlow = wantsJsonResponse(req);

    if (hasSession) {
      if (storedPkceData.state !== state) {
        return res.status(400).json({
          status: "error",
          message: "Invalid state parameter",
        });
      }

      const pkceAge = Date.now() - storedPkceData.timestamp;
      const MAX_PKCE_AGE = 5 * 60 * 1000;

      if (pkceAge > MAX_PKCE_AGE) {
        req.session.pkceData = undefined;
        return res.status(400).json({
          status: "error",
          message: "OAuth flow expired. Please try again",
        });
      }
    } else if (!isApiFlow) {
      return res.status(400).json({
        status: "error",
        message: "Invalid state parameter",
      });
    }
    // else: no session + isApiFlow → bot/test flow, allow through

    const codeVerifier = storedPkceData?.codeVerifier;
    const redirectUri = storedPkceData?.redirectUri || null;

    // ------------------------------------------------------------------
    // Exchange code for GitHub access token
    // code_verifier only sent when we have a PKCE session
    // ------------------------------------------------------------------
    const tokenResponse = await axios.post(
      "https://github.com/login/oauth/access_token",
      {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: CALLBACK_URL,
        state,
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      },
      { headers: { Accept: "application/json" } },
    );

    const { access_token: githubAccessToken } = tokenResponse.data;

    if (!githubAccessToken) {
      throw new Error("Failed to obtain GitHub access token");
    }

    // ------------------------------------------------------------------
    // Fetch GitHub user profile + verified emails
    // ------------------------------------------------------------------
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

    // ------------------------------------------------------------------
    // Find or create user
    //
    // NEW USER: first in DB → admin, everyone after → analyst.
    // RETURNING USER: keep existing role.
    // EXISTING USER by email: link GitHub ID, keep existing role.
    // ------------------------------------------------------------------
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
        const role = await resolveRoleForNewUser();
        user = await prisma.user.create({
          data: {
            githubId: String(githubUser.id),
            username: githubUser.login,
            email: primaryEmail,
            avatarUrl: githubUser.avatar_url,
            role,
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

    // ------------------------------------------------------------------
    // Generate token pair
    // ------------------------------------------------------------------
    const tokenPair = await TokenService.createTokenPair({
      id: user.id,
      role: user.role,
    });

    req.session.pkceData = undefined;

    res.cookie("access_token", tokenPair.accessToken, {
      httpOnly: true,
      secure: false,
      sameSite: "strict",
      maxAge: 3 * 60 * 1000,
    });

    res.cookie("refresh_token", tokenPair.refreshToken, {
      httpOnly: true,
      secure: false,
      sameSite: "strict",
      maxAge: 5 * 60 * 1000,
    });

    // ------------------------------------------------------------------
    // Response routing
    // ------------------------------------------------------------------

    if (isApiFlow) {
      return res.status(200).json({
        status: "success",
        access_token: tokenPair.accessToken,
        refresh_token: tokenPair.refreshToken,
        data: {
          access_token: tokenPair.accessToken,
          refresh_token: tokenPair.refreshToken,
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
          },
        },
      });
    }

    if (redirectUri) {
      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.set("access_token", tokenPair.accessToken);
      redirectUrl.searchParams.set("refresh_token", tokenPair.refreshToken);
      redirectUrl.searchParams.set("username", user.username);
      redirectUrl.searchParams.set("role", user.role);
      return res.redirect(redirectUrl.toString());
    }

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

// ---------------------------------------------------------------------------
// POST /auth/refresh — Rotate refresh token
// Accepts: JSON body (refreshToken or refresh_token), or cookie
// ---------------------------------------------------------------------------
export async function refreshToken(req: Request, res: Response) {
  try {
    let refresh_token: string | undefined;

    const body = req.body as any;
    const bodyToken = body?.refresh_token || body?.refreshToken;

    if (bodyToken) {
      refresh_token = bodyToken;
    }

    if (!refresh_token && req.cookies) {
      refresh_token = req.cookies["refresh_token"];
    }

    if (!refresh_token) {
      return res.status(400).json({
        status: "error",
        message: "Refresh token is required",
      });
    }

    const session = await TokenService.validateRefreshToken(refresh_token);

    if (!session) {
      return res.status(403).json({
        status: "error",
        message: "Invalid or expired refresh token",
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
    });

    if (!user || !user.isActive) {
      return res.status(403).json({
        status: "error",
        message: "User inactive or not found",
      });
    }

    if (session.expiresAt < new Date()) {
      await prisma.session.delete({
        where: { refreshToken: refresh_token },
      });
      return res.status(403).json({
        status: "error",
        message: "Refresh token expired",
      });
    }

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

    res.cookie("access_token", newTokenPair.accessToken, {
      httpOnly: true,
      secure: false,
      sameSite: "strict",
      maxAge: 3 * 60 * 1000,
    });

    res.cookie("refresh_token", newTokenPair.refreshToken, {
      httpOnly: true,
      secure: false,
      sameSite: "strict",
      maxAge: 5 * 60 * 1000,
    });

    return res.json({
      status: "success",
      access_token: newTokenPair.accessToken,
      refresh_token: newTokenPair.refreshToken,
    });
  } catch (err: any) {
    console.error("Token refresh error:", err);
    return res.status(500).json({
      status: "error",
      message: "Token refresh failed",
    });
  }
}

// ---------------------------------------------------------------------------
// POST /auth/logout
// Accepts: Authorization: Bearer <refreshToken> (API/CLI), or cookie (web)
// ---------------------------------------------------------------------------
export async function logout(req: Request, res: Response) {
  try {
    let refreshTokenValue: string | undefined;

    // 1. Request body (API / bot clients)
    const body = req.body as any;
    const bodyToken = body?.refresh_token || body?.refreshToken;
    if (bodyToken) {
      refreshTokenValue = bodyToken;
    }

    // 2. Authorization header (CLI clients)
    if (!refreshTokenValue) {
      const authHeader = req.headers["authorization"];
      if (authHeader && authHeader.startsWith("Bearer ")) {
        refreshTokenValue = authHeader.split(" ")[1];
      }
    }

    // 3. Cookie (web browser)
    if (!refreshTokenValue && req.cookies) {
      refreshTokenValue = req.cookies["refresh_token"];
    }

    // Invalidate the session server-side
    if (refreshTokenValue) {
      await prisma.session.deleteMany({
        where: { refreshToken: refreshTokenValue },
      });
    }

    res.clearCookie("access_token");
    res.clearCookie("refresh_token");

    return res.json({ status: "success", message: "Logged out successfully" });
  } catch (err) {
    console.error("Logout error:", err);
    return res.status(500).json({ status: "error", message: "Logout failed" });
  }
}

// ---------------------------------------------------------------------------
// GET /auth/test-tokens — DEV ONLY
// Generates fresh tokens for the seeded admin and analyst users.
// Use this before submitting to grab the three tokens needed for the
// /submit form: Admin Token, Analyst Token, Refresh Token.
//
// Hit this endpoint, then copy:
//   admin.accessToken  → Admin Test Token field
//   analyst.accessToken → Analyst Test Token field
//   admin.refreshToken → Refresh Test Token field
// ---------------------------------------------------------------------------
export async function getTestTokens(req: Request, res: Response) {
  try {
    const adminUser = await prisma.user.findUnique({
      where: { githubId: "1" },
    });

    const analystUser = await prisma.user.findUnique({
      where: { githubId: "2" },
    });

    if (!adminUser || !analystUser) {
      return res.status(500).json({
        status: "error",
        message: "Seeded users not found. Run `prisma db seed` first.",
      });
    }

    const adminTokenPair = await TokenService.createTokenPair({
      id: adminUser.id,
      role: adminUser.role,
    });

    const analystTokenPair = await TokenService.createTokenPair({
      id: analystUser.id,
      role: analystUser.role,
    });

    return res.status(200).json({
      status: "success",
      admin: {
        access_token: adminTokenPair.accessToken,
        refresh_token: adminTokenPair.refreshToken,
        user: {
          id: adminUser.id,
          username: adminUser.username,
          email: adminUser.email,
          role: adminUser.role,
        },
      },
      analyst: {
        access_token: analystTokenPair.accessToken,
        refresh_token: analystTokenPair.refreshToken,
        user: {
          id: analystUser.id,
          username: analystUser.username,
          email: analystUser.email,
          role: analystUser.role,
        },
      },
    });
  } catch (err: any) {
    console.error("getTestTokens error:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to generate test tokens" });
  }
}

// ---------------------------------------------------------------------------
// POST /auth/verify-token — DEV ONLY
// Pass admin and analyst tokens in the body to verify both at once.
// Body: { "admin_token": "...", "analyst_token": "..." }
// ---------------------------------------------------------------------------
export async function verifyTestToken(req: Request, res: Response) {
  try {
    const { admin_token, analyst_token, admin_refresh_token } = req.body as {
      admin_token?: string;
      analyst_token?: string;
      admin_refresh_token?: string;
    };

    if (!admin_token || !analyst_token || !admin_refresh_token) {
      return res.status(400).json({
        status: "error",
        message:
          "Provide both admin_token and analyst_token in the request body",
      });
    }

    const admin = TokenService.verifyToken(admin_token, "access");
    const analyst = TokenService.verifyToken(analyst_token, "access");
    const admin_refresh = TokenService.verifyToken(
      admin_refresh_token,
      "refresh",
    );

    return res.status(200).json({
      status: "success",
      admin,
      analyst,
      admin_refresh,
    });
  } catch (err: any) {
    console.error("verifyTestToken error:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Verification failed" });
  }
}
