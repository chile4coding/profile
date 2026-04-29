import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth";
import { Role } from "../types/roles";

export const authorizeRole = (...allowedRoles: Role[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res
          .status(401)
          .json({ status: "error", message: "Authentication required" });
      }

      if (!allowedRoles.includes(req.user.role as Role)) {
        return res
          .status(403)
          .json({ status: "error", message: "Insufficient permissions" });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};
