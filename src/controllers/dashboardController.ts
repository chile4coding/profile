import { Request, Response } from "express";
import prisma from "../services/db";
import { toSnakeList } from "../utils/serializer";

interface GenderStat {
  gender: string | null;
  _count: { gender: number };
}

interface AgeGroupStat {
  ageGroup: string | null;
  _count: { ageGroup: number };
}

export async function getDashboardStats(req: Request, res: Response) {
  try {
    // Total users
    const totalProfiles = await prisma.profile.count();

    // Total profiles by gender
    const genderStats = await prisma.profile.groupBy({
      by: ["gender"],
      where: { gender: { not: null } },
      _count: { gender: true },
    });

    const totalMale =
      genderStats.find((g: GenderStat) => g.gender?.toLowerCase() === "male")
        ?._count.gender || 0;
    const totalFemale =
      genderStats.find((g: GenderStat) => g.gender?.toLowerCase() === "female")
        ?._count.gender || 0;

    // Total profiles by age group
    const ageGroupStats = await prisma.profile.groupBy({
      by: ["ageGroup"],
      where: { ageGroup: { not: null } },
      _count: { ageGroup: true },
    });

    const totalChildren =
      ageGroupStats.find(
        (a: AgeGroupStat) => a.ageGroup?.toLowerCase() === "child",
      )?._count.ageGroup || 0;

    // Most recent profiles created in the last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentProfiles = await prisma.profile.count({
      where: {
        createdAt: { gte: sevenDaysAgo },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return res.status(200).json({
      status: "success",
      data: {
        totalUsers: totalProfiles,
        totalMale,
        totalFemale,
        totalChildren,
        recentProfiles: recentProfiles,
      },
    });
  } catch (err) {
    console.error("Dashboard stats error:", err);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to fetch dashboard stats" });
  }
}
