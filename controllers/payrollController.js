import { Op } from "sequelize";
import Employee from "../models/Employee.js";
import Attendance from "../models/Attendance.js";
import Payroll from "../models/Payroll.js";
import Holiday from "../models/Holiday.js";

function ensureAdmin(req) {
  const role = req.user && req.user.role ? String(req.user.role).toLowerCase() : null;

  if (!role || (role !== "admin" && role !== "manager")) {
    const error = new Error("Forbidden");
    error.statusCode = 403;
    throw error;
  }
}

function getPayrollCycleRange(year, month) {
  // Payroll cycle: 21st of previous month (inclusive) to 21st of given month (inclusive)
  const cycleEnd = new Date(year, month - 1, 21);
  const cycleStart = new Date(cycleEnd);
  cycleStart.setMonth(cycleStart.getMonth() - 1);

  return {
    startDate: cycleStart,
    endDate: cycleEnd,
  };
}

async function getWorkingDaysInCycle(year, month) {
  const { startDate, endDate } = getPayrollCycleRange(year, month);
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  const holidays = await Holiday.findAll({
    where: {
      countryCode: "LK",
      isPublicHoliday: true,
      date: {
        [Op.between]: [startStr, endStr],
      },
    },
  });

  const holidaySet = new Set(holidays.map((h) => h.date));

  let workingDays = 0;
  const current = new Date(startDate);
  while (current <= endDate) {
    const day = current.getDay(); // 0 = Sunday, 6 = Saturday
    const dateStr = current.toISOString().slice(0, 10);

    const isWeekend = day === 0 || day === 6;
    const isHoliday = holidaySet.has(dateStr);

    if (!isWeekend && !isHoliday) {
      workingDays += 1;
    }

    current.setDate(current.getDate() + 1);
  }

  return workingDays;
}

async function computeAttendanceAndOtBreakdown(employeeId, year, month) {
  const { startDate, endDate } = getPayrollCycleRange(year, month);
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  const holidays = await Holiday.findAll({
    where: {
      countryCode: "LK",
      isPublicHoliday: true,
      date: {
        [Op.between]: [startStr, endStr],
      },
    },
  });

  const holidaySet = new Set(holidays.map((h) => h.date));

  const attendanceRecords = await Attendance.findAll({
    where: {
      employeeId,
      date: {
        [Op.between]: [startStr, endStr],
      },
    },
  });

  let totalWorkingHours = 0;
  let totalOtHours = 0;
  let normalOtHours = 0;
  let holidayOtHours = 0;
  let annualLeaveDays = 0;
  let sickLeaveDays = 0;
  let noPayDays = 0;

  attendanceRecords.forEach((rec) => {
    const workingHours = Number(rec.workingHours || 0);
    const otHours = Number(rec.otHours || 0);

    totalWorkingHours += workingHours;
    totalOtHours += otHours;

    if (rec.status === "Annual Leave") {
      annualLeaveDays += 1;
    } else if (rec.status === "Sick Leave") {
      sickLeaveDays += 1;
    } else if (rec.status === "No Pay") {
      noPayDays += 1;
    }

    let isSpecialOtDay = false;

    if (rec.dayType === "Sunday" || rec.dayType === "MercantileHoliday") {
      isSpecialOtDay = true;
    } else if (holidaySet.has(rec.date)) {
      // Public holidays (e.g. Poya days)
      isSpecialOtDay = true;
    }

    if (isSpecialOtDay) {
      holidayOtHours += otHours;
    } else {
      normalOtHours += otHours;
    }
  });

  totalWorkingHours = Number(totalWorkingHours.toFixed(2));
  totalOtHours = Number(totalOtHours.toFixed(2));
  normalOtHours = Number(normalOtHours.toFixed(2));
  holidayOtHours = Number(holidayOtHours.toFixed(2));

  let workingDaysPerMonth = 0;
  const current = new Date(startDate);
  while (current <= endDate) {
    const day = current.getDay(); // 0 = Sunday, 6 = Saturday
    const dateStr = current.toISOString().slice(0, 10);

    const isWeekend = day === 0 || day === 6;
    const isHoliday = holidaySet.has(dateStr);

    if (!isWeekend && !isHoliday) {
      workingDaysPerMonth += 1;
    }

    current.setDate(current.getDate() + 1);
  }

  return {
    startDate,
    endDate,
    startStr,
    endStr,
    totalWorkingHours,
    totalOtHours,
    normalOtHours,
    holidayOtHours,
    annualLeaveDays,
    sickLeaveDays,
    noPayDays,
    workingDaysPerMonth,
  };
}

function sumCustomItems(items) {
  if (!Array.isArray(items)) return 0;
  return Number(
    items
      .reduce((sum, item) => {
        const amount = Number(item && item.amount != null ? item.amount : 0);
        if (Number.isNaN(amount)) return sum;
        return sum + amount;
      }, 0)
      .toFixed(2)
  );
}

function calculatePayrollFigures({
  baseSalary,
  otPay,
  noPayDeduction,
  incentive,
  customAllowancesTotal = 0,
  customDeductionsTotal = 0,
}) {
  const base = Number(baseSalary || 0);
  const ot = Number(otPay || 0);
  const noPay = Number(noPayDeduction || 0);
  const inc = Number(incentive || 0);

  const extraAllow = Number(customAllowancesTotal || 0);
  const extraDed = Number(customDeductionsTotal || 0);

  const fullSalary = base + ot - noPay + inc + extraAllow - extraDed;
  const epfDeduction = fullSalary * 0.08;
  const netSalary = fullSalary - epfDeduction;

  return {
    fullSalary: Number(fullSalary.toFixed(2)),
    epfDeduction: Number(epfDeduction.toFixed(2)),
    netSalary: Number(netSalary.toFixed(2)),
  };
}

export async function getEmployeePayroll(req, res) {
  try {
    ensureAdmin(req);

    const { employeeId } = req.params;
    const now = new Date();
    const year = req.query.year ? Number(req.query.year) : now.getFullYear();
    const month = req.query.month ? Number(req.query.month) : now.getMonth() + 1; // 1-12
    const finalize =
      req.query.finalize === "true" || req.query.finalize === "1" || req.query.finalize === 1;

    let incentive = 0;
    if (req.query.incentive != null) {
      const incNum = Number(req.query.incentive);
      if (Number.isNaN(incNum)) {
        res.status(400).json({ message: "incentive must be a valid number" });
        return;
      }
      incentive = Number(incNum.toFixed(2));
      if (incentive < 0) {
        res.status(400).json({ message: "incentive cannot be negative" });
        return;
      }
    }

    if (!employeeId) {
      res.status(400).json({ message: "employeeId is required" });
      return;
    }

    const employee = await Employee.findByPk(employeeId);
    if (!employee) {
      res.status(404).json({ message: "Employee not found" });
      return;
    }
    const attendanceInfo = await computeAttendanceAndOtBreakdown(employeeId, year, month);

    const baseSalary = Number(employee.baseSalary || 0);

    // Normal working day OT: OT Hours = workingHours - 8, OT Rate = (Base Salary/200) * 1.5
    const normalOtRate = baseSalary > 0 ? (baseSalary / 200) * 1.5 : 0;
    const holidayOtRate = baseSalary > 0 ? (baseSalary / 200) * 2 : 0;

    const normalOtPay = attendanceInfo.normalOtHours * normalOtRate;
    const holidayOtPay = attendanceInfo.holidayOtHours * holidayOtRate;

    const otPay = normalOtPay + holidayOtPay;

    const noPayPerDay =
      attendanceInfo.workingDaysPerMonth > 0
        ? baseSalary / attendanceInfo.workingDaysPerMonth
        : 0;
    const noPayDeduction = noPayPerDay * attendanceInfo.noPayDays;

    // Try to load existing payroll record
    let payroll = await Payroll.findOne({ where: { employeeId, year, month } });

    let finalIncentive = 0;
    if (req.query.incentive != null) {
      finalIncentive = incentive;
    } else if (payroll) {
      finalIncentive = Number(payroll.incentive || 0);
    }

    // Handle custom allowances and deductions coming from the request.
    // They are expected as JSON-encoded arrays in the query string.
    let customAllowances = [];
    let customDeductions = [];

    const allowancesProvided = Object.prototype.hasOwnProperty.call(
      req.query,
      "allowances"
    );
    const deductionsProvided = Object.prototype.hasOwnProperty.call(
      req.query,
      "deductions"
    );

    if (allowancesProvided && typeof req.query.allowances === "string") {
      try {
        const parsed = JSON.parse(req.query.allowances);
        if (Array.isArray(parsed)) {
          customAllowances = parsed.map((item) => ({
            label: String(item.label || "").slice(0, 100),
            amount: Number(item.amount || 0),
          }));
        }
      } catch (e) {
        console.warn("Failed to parse custom allowances JSON", e);
      }
    }

    if (deductionsProvided && typeof req.query.deductions === "string") {
      try {
        const parsed = JSON.parse(req.query.deductions);
        if (Array.isArray(parsed)) {
          customDeductions = parsed.map((item) => ({
            label: String(item.label || "").slice(0, 100),
            amount: Number(item.amount || 0),
          }));
        }
      } catch (e) {
        console.warn("Failed to parse custom deductions JSON", e);
      }
    }

    // If not provided in the request, reuse any previously stored values
    // for this payroll record (if it exists).
    if (payroll) {
      if (!allowancesProvided) {
        customAllowances = payroll.customAllowances || [];
      }
      if (!deductionsProvided) {
        customDeductions = payroll.customDeductions || [];
      }
    }

    const customAllowancesTotal = sumCustomItems(customAllowances);
    const customDeductionsTotal = sumCustomItems(customDeductions);

    const { fullSalary, epfDeduction, netSalary } = calculatePayrollFigures({
      baseSalary,
      otPay,
      noPayDeduction,
      incentive: finalIncentive,
      customAllowancesTotal,
      customDeductionsTotal,
    });

    if (finalize) {
      // For finalization (from Download Paysheet), remove any existing
      // payroll records for the same employee/year/month and create a
      // fresh one with the latest values.
      await Payroll.destroy({ where: { employeeId, year, month } });

      payroll = await Payroll.create({
        employeeId,
        year,
        month,
        baseSalary,
        totalWorkingHours: attendanceInfo.totalWorkingHours,
        totalOtHours: attendanceInfo.totalOtHours,
        annualLeaveDays: attendanceInfo.annualLeaveDays,
        sickLeaveDays: attendanceInfo.sickLeaveDays,
        noPayDays: attendanceInfo.noPayDays,
        otRate: Number(normalOtRate.toFixed(2)),
        otPay: Number(otPay.toFixed(2)),
        noPayDeduction: Number(noPayDeduction.toFixed(2)),
        epfDeduction,
        customAllowances,
        customDeductions,
        incentive: finalIncentive,
        netSalary,
      });
    } else if (!payroll) {
      payroll = await Payroll.create({
        employeeId,
        year,
        month,
        baseSalary,
        totalWorkingHours: attendanceInfo.totalWorkingHours,
        totalOtHours: attendanceInfo.totalOtHours,
        annualLeaveDays: attendanceInfo.annualLeaveDays,
        sickLeaveDays: attendanceInfo.sickLeaveDays,
        noPayDays: attendanceInfo.noPayDays,
        otRate: Number(normalOtRate.toFixed(2)),
        otPay: Number(otPay.toFixed(2)),
        noPayDeduction: Number(noPayDeduction.toFixed(2)),
        epfDeduction,
        customAllowances,
        customDeductions,
        incentive: finalIncentive,
        netSalary,
      });
    } else {
      payroll.baseSalary = baseSalary;
      payroll.totalWorkingHours = attendanceInfo.totalWorkingHours;
      payroll.totalOtHours = attendanceInfo.totalOtHours;
      payroll.annualLeaveDays = attendanceInfo.annualLeaveDays;
      payroll.sickLeaveDays = attendanceInfo.sickLeaveDays;
      payroll.noPayDays = attendanceInfo.noPayDays;
      payroll.otRate = Number(normalOtRate.toFixed(2));
      payroll.otPay = Number(otPay.toFixed(2));
      payroll.noPayDeduction = Number(noPayDeduction.toFixed(2));
      payroll.epfDeduction = epfDeduction;
      payroll.customAllowances = customAllowances;
      payroll.customDeductions = customDeductions;
      payroll.incentive = finalIncentive;
      payroll.netSalary = netSalary;
      await payroll.save();
    }

    const payrollData = payroll.toJSON ? payroll.toJSON() : payroll;
    payrollData.fullSalary = fullSalary;
    payrollData.epfDeduction = epfDeduction;
    payrollData.netSalary = netSalary;

    payrollData.customAllowances = customAllowances;
    payrollData.customDeductions = customDeductions;

    payrollData.normalOtHours = attendanceInfo.normalOtHours;
    payrollData.holidayOtHours = attendanceInfo.holidayOtHours;
    payrollData.normalOtRate = Number(normalOtRate.toFixed(2));
    payrollData.holidayOtRate = Number(holidayOtRate.toFixed(2));
    payrollData.normalOtPay = Number(normalOtPay.toFixed(2));
    payrollData.holidayOtPay = Number(holidayOtPay.toFixed(2));

    res.json({
      employee: {
        employeeId: employee.employeeId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        etfNumber: employee.etfNumber,
        idNumber: employee.idNumber,
        telephone: employee.telephone,
        department: employee.department,
        role: employee.role,
      },
      period: {
        year,
        month,
        startDate: attendanceInfo.startStr,
        endDate: attendanceInfo.endStr,
      },
      payroll: payrollData,
    });
  } catch (err) {
    console.error("Error fetching payroll:", err);
    res.status(err.statusCode || 500).json({
      message: err.statusCode === 403 ? "Only admins can perform this action" : "Failed to fetch payroll",
    });
  }
}

export async function getEmployeePayrollHistory(req, res) {
  try {
    ensureAdmin(req);

    const { employeeId } = req.params;

    if (!employeeId) {
      res.status(400).json({ message: "employeeId is required" });
      return;
    }

    const employee = await Employee.findByPk(employeeId);
    if (!employee) {
      res.status(404).json({ message: "Employee not found" });
      return;
    }

    const payrolls = await Payroll.findAll({
      where: { employeeId },
      order: [
        ["year", "DESC"],
        ["month", "DESC"],
      ],
    });

    const items = payrolls.map((p) => {
      const plain = p.toJSON ? p.toJSON() : p;

      const customAllowancesTotal = sumCustomItems(plain.customAllowances || []);
      const customDeductionsTotal = sumCustomItems(plain.customDeductions || []);

      const figures = calculatePayrollFigures({
        baseSalary: plain.baseSalary,
        otPay: plain.otPay,
        noPayDeduction: plain.noPayDeduction,
        incentive: plain.incentive,
        customAllowancesTotal,
        customDeductionsTotal,
      });

      const { startDate, endDate } = getPayrollCycleRange(plain.year, plain.month);
      const startStr = startDate.toISOString().slice(0, 10);
      const endStr = endDate.toISOString().slice(0, 10);

      return {
        id: plain.id,
        year: plain.year,
        month: plain.month,
        periodStart: startStr,
        periodEnd: endStr,
        baseSalary: Number(plain.baseSalary || 0),
        otPay: Number(plain.otPay || 0),
        noPayDeduction: Number(plain.noPayDeduction || 0),
        incentive: Number(plain.incentive || 0),
        fullSalary: figures.fullSalary,
        epfDeduction: figures.epfDeduction,
        netSalary: figures.netSalary,
        createdAt: plain.createdAt,
      };
    });

    res.json({
      employee: {
        employeeId: employee.employeeId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        etfNumber: employee.etfNumber,
        idNumber: employee.idNumber,
        telephone: employee.telephone,
        department: employee.department,
        role: employee.role,
      },
      payrolls: items,
    });
  } catch (err) {
    console.error("Error fetching payroll history:", err);
    res.status(err.statusCode || 500).json({
      message:
        err.statusCode === 403
          ? "Only admins can perform this action"
          : "Failed to fetch payroll history",
    });
  }
}
