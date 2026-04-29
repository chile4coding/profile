import { Request, Response, NextFunction } from "express";

export const requireApiVersion = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const version = req.headers["api-version"] || req.headers["x-api-version"];
  if (!version || version !== "1") {
    // ← confirm expected value
    return res.status(400).json({ error: "API version required" });
  }
  next();
};
