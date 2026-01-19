import Employee from "../models/Employee.js";

function ensureAdmin(req) {
  const role = req.user && req.user.role ? String(req.user.role).toLowerCase() : null;

  if (!role || role !== "admin") {
    const error = new Error("Forbidden");
    error.statusCode = 403;
    throw error;
  }
}

export async function createEmployee(req, res) {
  try {
    ensureAdmin(req);

    const { employeeId, firstName, lastName, address, role, image, baseSalary, allowances, deductions } = req.body;

    if (!employeeId || !firstName || !lastName || !address || !role || baseSalary == null) {
      res.status(400).json({
        message: "employeeId, firstName, lastName, address, role and baseSalary are required",
      });
      return;
    }

    const existing = await Employee.findOne({ where: { employeeId } });
    if (existing) {
      res.status(409).json({ message: "Employee with this ID already exists" });
      return;
    }

    const employee = await Employee.create({
      employeeId,
      firstName,
      lastName,
      address,
      role,
      image,
      baseSalary,
    });

    res.status(201).json({
      message: "Employee created successfully",
      employee,
    });
  } catch (err) {
    console.error("Error creating employee:", err);

    if (err.statusCode === 403) {
      res.status(403).json({ message: "Only admins can perform this action" });
      return;
    }

    if (err.name === "SequelizeValidationError" || err.name === "SequelizeUniqueConstraintError") {
      res.status(400).json({ message: err.errors?.[0]?.message || "Invalid employee data" });
      return;
    }

    res.status(500).json({ message: "Failed to create employee" });
  }
}

export async function getEmployees(req, res) {
  try {
    ensureAdmin(req);

    const employees = await Employee.findAll();

    res.json({ employees });
  } catch (err) {
    console.error("Error fetching employees:", err);
    res.status(err.statusCode || 500).json({
      message: err.statusCode === 403 ? "Only admins can perform this action" : "Failed to fetch employees",
    });
  }
}

export async function getEmployeeById(req, res) {
  try {
    ensureAdmin(req);

    const { employeeId } = req.params;
    const employee = await Employee.findOne({ where: { employeeId } });

    if (!employee) {
      res.status(404).json({ message: "Employee not found" });
      return;
    }

    res.json({ employee });
  } catch (err) {
    console.error("Error fetching employee:", err);
    res.status(err.statusCode || 500).json({
      message: err.statusCode === 403 ? "Only admins can perform this action" : "Failed to fetch employee",
    });
  }
}

export async function updateEmployee(req, res) {
  try {
    ensureAdmin(req);

    const { employeeId: paramEmployeeId } = req.params;
    const { employeeId, firstName, lastName, address, role, image, baseSalary, allowances, deductions } = req.body;

    const employee = await Employee.findOne({ where: { employeeId: paramEmployeeId } });

    if (!employee) {
      res.status(404).json({ message: "Employee not found" });
      return;
    }

    await employee.update({
      employeeId,
      firstName,
      lastName,
      address,
      role,
      image,
      baseSalary,
      allowances,
      deductions,
    });

    res.json({
      message: "Employee updated successfully",
      employee,
    });
  } catch (err) {
    console.error("Error updating employee:", err);
    res.status(err.statusCode || 500).json({
      message: err.statusCode === 403 ? "Only admins can perform this action" : "Failed to update employee",
    });
  }
}

export async function deleteEmployee(req, res) {
  try {
    ensureAdmin(req);

    const { employeeId } = req.params;
    const employee = await Employee.findOne({ where: { employeeId } });

    if (!employee) {
      res.status(404).json({ message: "Employee not found" });
      return;
    }

    await employee.destroy();

    res.json({ message: "Employee deleted successfully" });
  } catch (err) {
    console.error("Error deleting employee:", err);
    res.status(err.statusCode || 500).json({
      message: err.statusCode === 403 ? "Only admins can perform this action" : "Failed to delete employee",
    });
  }
}
