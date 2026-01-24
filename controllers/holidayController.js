import { Op } from "sequelize";
import Holiday from "../models/Holiday.js";

function ensureAdmin(req) {
  const role = req.user && req.user.role ? String(req.user.role).toLowerCase() : null;

  if (!role || (role !== "admin" && role !== "manager")) {
    const error = new Error("Forbidden");
    error.statusCode = 403;
    throw error;
  }
}

export async function getMonthlyMercantileHolidays(req, res) {
  try {
    ensureAdmin(req);

    const now = new Date();
    const year = req.query.year ? Number(req.query.year) : now.getFullYear();
    const month = req.query.month ? Number(req.query.month) : now.getMonth() + 1; // 1-12

    if (!year || !month || month < 1 || month > 12) {
      res.status(400).json({ message: "year and month must be valid" });
      return;
    }

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    const holidays = await Holiday.findAll({
      where: {
        countryCode: "LK",
        isMercantileHoliday: true,
        date: {
          [Op.between]: [startStr, endStr],
        },
      },
      order: [["date", "ASC"]],
    });

    res.json({
      year,
      month,
      holidays,
    });
  } catch (err) {
    console.error("Error fetching mercantile holidays:", err);
    res.status(err.statusCode || 500).json({
      message:
        err.statusCode === 403
          ? "Only admins can perform this action"
          : "Failed to fetch mercantile holidays",
    });
  }
}

export async function getMonthlySriLankaHolidays(req, res) {
  try {
    ensureAdmin(req);

    const now = new Date();
    const year = req.query.year ? Number(req.query.year) : now.getFullYear();
    const month = req.query.month ? Number(req.query.month) : now.getMonth() + 1; // 1-12

    if (!year || !month || month < 1 || month > 12) {
      res.status(400).json({ message: "year and month must be valid" });
      return;
    }

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    const holidays = await Holiday.findAll({
      where: {
        countryCode: "LK",
        date: {
          [Op.between]: [startStr, endStr],
        },
      },
      order: [["date", "ASC"]],
    });

    res.json({
      year,
      month,
      holidays,
    });
  } catch (err) {
    console.error("Error fetching Sri Lankan holidays:", err);
    res.status(err.statusCode || 500).json({
      message:
        err.statusCode === 403
          ? "Only admins can perform this action"
          : "Failed to fetch Sri Lankan holidays",
    });
  }
}
