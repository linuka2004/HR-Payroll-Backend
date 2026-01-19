import express from "express";
import { getMonthlyMercantileHolidays, getMonthlySriLankaHolidays } from "../controllers/holidayController.js";

const holidayRouter = express.Router();

// All holiday routes are protected by JWT in index.js
// and controllers enforce admin-only access.

holidayRouter.get("/mercantile", getMonthlyMercantileHolidays);
holidayRouter.get("/monthly", getMonthlySriLankaHolidays);

export default holidayRouter;
