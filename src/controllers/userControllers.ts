import { Request, Response } from "express";

import prisma from "../services/db";
// Get current user

export async function getCurrentUser(req: Request, res: Response) {
  try {
    // This endpoint is protected by authenticate middleware
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
