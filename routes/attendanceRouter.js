import express from "express";
import multer from "multer";
import {
  recordAttendance,
  getEmployeeMonthlyAttendance,
  getAllEmployeesLeaveSummary,
  getSingleEmployeeLeaveSummary,
  uploadAttendanceExcel,
} from "../controllers/attendanceController.js";

const attendanceRouter = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// All attendance routes are protected by JWT in index.js,
// and the controller enforces admin-only access.

attendanceRouter.get("/leaves/summary", getAllEmployeesLeaveSummary);
attendanceRouter.get("/leaves/summary/:employeeId", getSingleEmployeeLeaveSummary);
attendanceRouter.post(
  "/:employeeId/upload-excel",
  upload.single("file"),
  uploadAttendanceExcel
);
attendanceRouter.post("/:employeeId", recordAttendance);
attendanceRouter.get("/:employeeId", getEmployeeMonthlyAttendance);

export default attendanceRouter;
