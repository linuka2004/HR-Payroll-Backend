import express from "express";
import { getEmployeePayroll, getEmployeePayrollHistory } from "../controllers/payrollController.js";

const payrollRouter = express.Router();

// All payroll routes are protected by JWT in index.js and
// payrollController enforces admin-only access.

payrollRouter.get("/employee/:employeeId", getEmployeePayroll);
payrollRouter.get("/employee/:employeeId/history", getEmployeePayrollHistory);

export default payrollRouter;
