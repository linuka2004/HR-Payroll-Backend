import express from "express";
import {
  createEmployee,
  getEmployees,
  getEmployeeById,
  updateEmployee,
  deleteEmployee,
} from "../controllers/employeeController.js";

const employeeRouter = express.Router();

// All routes are protected by the JWT middleware in index.js,
// and employeeController checks for admin role.

employeeRouter.post("/", createEmployee);
employeeRouter.get("/", getEmployees);
employeeRouter.get("/:employeeId", getEmployeeById);
employeeRouter.put("/:employeeId", updateEmployee);
employeeRouter.delete("/:employeeId", deleteEmployee);

export default employeeRouter;
