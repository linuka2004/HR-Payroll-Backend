import { Op } from "sequelize";
import Attendance from "../models/Attendance.js";
import Employee from "../models/Employee.js";
import Holiday from "../models/Holiday.js";
import xlsx from "xlsx";

function ensureAdmin(req) {
  const role = req.user && req.user.role ? String(req.user.role).toLowerCase() : null;

  if (!role || (role !== "admin" && role !== "manager")) {
    const error = new Error("Forbidden");
    error.statusCode = 403;
    throw error;
  }
}

function getPayrollCycleRange(year, month) {
  // Payroll/attendance cycle: 21st of previous month (inclusive) to 21st of given month (inclusive)
  const cycleEnd = new Date(year, month - 1, 21);
  const cycleStart = new Date(cycleEnd);
  cycleStart.setMonth(cycleStart.getMonth() - 1);

  return {
    startDate: cycleStart,
    endDate: cycleEnd,
  };
}

function normalizeStatus(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (v === "present") return "Present";
  if (v === "annual" || v === "annual leave" || v === "annual_leave") return "Annual Leave";
  if (v === "sick" || v === "sick leave" || v === "sick_leave") return "Sick Leave";
  if (v === "no pay" || v === "nopay" || v === "no_pay") return "No Pay";
  return null;
}

function normalizeDayType(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (v === "normal") return "Normal";
  if (v === "sunday") return "Sunday";
  if (v === "mercantile" || v === "mercantileholiday" || v === "mercantile holiday")
    return "MercantileHoliday";
  return null;
}

function parseDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const str = String(value).trim();
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseTimeToDate(dateStr, value) {
  if (!value || !dateStr) return null;

  // If Excel already gave us a Date object, re-anchor it to the given date
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const hours = value.getHours();
    const minutes = value.getMinutes();
    const seconds = value.getSeconds();

    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");

    const d = new Date(`${dateStr}T${hh}:${mm}:${ss}`);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }

  // If Excel stored time as a number (serial), convert fraction of day to time
  if (typeof value === "number" && Number.isFinite(value)) {
    const dayFraction = value % 1; // keep only time part if date+time serial
    const msPerDay = 24 * 60 * 60 * 1000;
    const timeMs = Math.round(dayFraction * msPerDay);
    const base = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(base.getTime())) return null;
    return new Date(base.getTime() + timeMs);
  }

  let raw = String(value).trim();
  if (!raw) return null;

  // Handle 12-hour times with AM/PM, e.g. "9:00 AM", "5:30 pm"
  const ampmMatch = raw.match(/\s*(AM|PM)$/i);
  let hasAmPm = false;
  let isPm = false;
  if (ampmMatch) {
    hasAmPm = true;
    isPm = /PM$/i.test(ampmMatch[0]);
    raw = raw.replace(/\s*(AM|PM)$/i, "").trim();
  }

  const parts = raw.split(":");
  let hours = parseInt(parts[0], 10);
  let minutes = parts[1] != null && parts[1] !== "" ? parseInt(parts[1], 10) : 0;
  let seconds = parts[2] != null && parts[2] !== "" ? parseInt(parts[2], 10) : 0;

  if ([hours, minutes, seconds].some((n) => Number.isNaN(n) || n < 0)) return null;

  if (hasAmPm) {
    if (isPm && hours < 12) hours += 12; // 1PM-11PM
    if (!isPm && hours === 12) hours = 0; // 12AM -> 00:xx
  }

  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");

  const d = new Date(`${dateStr}T${hh}:${mm}:${ss}`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

async function calculateWorkingAndOtHours(dateStr, finalStatus, finalDayType, workingHours) {
  let dayWorkingHours = 0;
  let otHours = 0;

  if (finalStatus === "Annual Leave" || finalStatus === "Sick Leave" || finalStatus === "No Pay") {
    return { dayWorkingHours: 0, otHours: 0 };
  }

  const wh = Number(workingHours || 0);
  if (Number.isNaN(wh) || wh < 0) {
    throw new Error("Invalid working hours value");
  }

  const standardDayHours = 8;

  let isSpecialOtDay = false;

  if (finalDayType === "Sunday" || finalDayType === "MercantileHoliday") {
    isSpecialOtDay = true;
  } else {
    const holiday = await Holiday.findOne({
      where: {
        countryCode: "LK",
        date: dateStr,
        isPublicHoliday: true,
      },
    });

    if (holiday) {
      isSpecialOtDay = true;
    }
  }

  if (isSpecialOtDay) {
    dayWorkingHours = 0;
    otHours = wh;
  } else {
    const paidHours = Math.min(wh, standardDayHours);
    const ot = wh > standardDayHours ? wh - standardDayHours : 0;

    dayWorkingHours = Number(paidHours.toFixed(2));
    otHours = Number(ot.toFixed(2));
  }

  return { dayWorkingHours, otHours };
}

export async function recordAttendance(req, res) {
  try {
    ensureAdmin(req);

    const { employeeId: paramEmployeeId } = req.params;
    const { date, status, workingHours, dayType } = req.body;

    const employeeId = paramEmployeeId;

    if (!employeeId || !date) {
      res.status(400).json({ message: "employeeId (in URL) and date are required" });
      return;
    }

    const allowedStatuses = ["Present", "Annual Leave", "Sick Leave", "No Pay"];
    const allowedDayTypes = ["Normal", "Sunday", "MercantileHoliday"];
    let finalStatus = status;

    if (finalStatus && !allowedStatuses.includes(finalStatus)) {
      res.status(400).json({ message: "Invalid status value" });
      return;
    }

    let finalDayType = dayType;

    if (finalDayType && !allowedDayTypes.includes(finalDayType)) {
      res.status(400).json({ message: "Invalid dayType value" });
      return;
    }

    if (!finalDayType) {
      const parsedDate = new Date(date);
      if (Number.isNaN(parsedDate.getTime())) {
        res.status(400).json({ message: "Invalid date value" });
        return;
      }
      const dayOfWeek = parsedDate.getDay(); // 0 = Sunday
      finalDayType = dayOfWeek === 0 ? "Sunday" : "Normal";
    }

    const employee = await Employee.findByPk(employeeId);
    if (!employee) {
      res.status(404).json({ message: "Employee not found" });
      return;
    }

    let dayWorkingHours = 0;
    let otHours = 0;

    if (finalStatus === "Annual Leave" || finalStatus === "Sick Leave" || finalStatus === "No Pay") {
      dayWorkingHours = 0;
      otHours = 0;
    } else {
      finalStatus = "Present";

      if (workingHours == null) {
        res.status(400).json({ message: "workingHours is required for working days" });
        return;
      }

      const dateOnly = date;
      try {
        const result = await calculateWorkingAndOtHours(dateOnly, finalStatus, finalDayType, workingHours);
        dayWorkingHours = result.dayWorkingHours;
        otHours = result.otHours;
      } catch (err) {
        res.status(400).json({ message: err.message || "Invalid working hours" });
        return;
      }
    }

    const existing = await Attendance.findOne({ where: { employeeId, date } });

    let attendance;
    if (existing) {
      attendance = await existing.update({
        status: finalStatus,
        dayType: finalDayType,
        workingHours: dayWorkingHours,
        otHours,
      });
    } else {
      attendance = await Attendance.create({
        employeeId,
        date,
        status: finalStatus,
        dayType: finalDayType,
        workingHours: dayWorkingHours,
        otHours,
      });
    }

    res.status(200).json({
      message: "Attendance recorded successfully",
      attendance,
    });
  } catch (err) {
    console.error("Error recording attendance:", err);

    if (err.statusCode === 403) {
      res.status(403).json({ message: "Only admins can perform this action" });
      return;
    }

    res.status(500).json({
      message: "Failed to record attendance",
      error: err.message,
    });
  }
}

export async function uploadAttendanceExcel(req, res) {
  try {
    ensureAdmin(req);

    const { employeeId } = req.params;

    if (!employeeId) {
      res.status(400).json({ message: "employeeId (in URL) is required" });
      return;
    }

    const employee = await Employee.findByPk(employeeId);
    if (!employee) {
      res.status(404).json({ message: "Employee not found" });
      return;
    }

    if (!req.file || !req.file.buffer) {
      res.status(400).json({ message: "Excel file is required" });
      return;
    }

    const workbook = xlsx.read(req.file.buffer, { type: "buffer", cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    if (!rows || rows.length < 2) {
      res.status(400).json({ message: "Excel sheet is empty or missing data" });
      return;
    }

    const headerRow = rows[0];
    const normalizeHeader = (v) => String(v).trim().toLowerCase().replace(/\s+/g, "");

    const headerMap = headerRow.map((h) => normalizeHeader(h));

    const dateIdx = headerMap.indexOf("date");
    const dayTypeIdx = headerMap.indexOf("daytype");
    const statusIdx = headerMap.indexOf("status");
    const inTimeIdx = headerMap.indexOf("intime");
    const outTimeIdx = headerMap.indexOf("outtime");

    if (dateIdx === -1 || dayTypeIdx === -1 || statusIdx === -1 || inTimeIdx === -1 || outTimeIdx === -1) {
      res.status(400).json({
        message:
          "Excel header row must contain columns: date, day type, status, in time, out time (exact names)",
      });
      return;
    }

    let createdCount = 0;
    let updatedCount = 0;

    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || row.length === 0) continue;

      const rawDate = row[dateIdx];
      const dateStr = parseDateOnly(rawDate);
      if (!dateStr) continue;

      let finalDayType = normalizeDayType(row[dayTypeIdx]);
      let finalStatus = normalizeStatus(row[statusIdx]);

      if (!finalStatus) {
        throw new Error(`Invalid status value on row ${i + 1}`);
      }

      if (!finalDayType) {
        const parsedDate = new Date(dateStr);
        const dow = parsedDate.getDay();
        finalDayType = dow === 0 ? "Sunday" : "Normal";
      }

      const existing = await Attendance.findOne({ where: { employeeId, date: dateStr } });

      let payload;

      // For leave days, we don't require in/out times; working and OT hours are zero
      if (
        finalStatus === "Annual Leave" ||
        finalStatus === "Sick Leave" ||
        finalStatus === "No Pay"
      ) {
        payload = {
          status: finalStatus,
          dayType: finalDayType,
          checkInTime: null,
          checkOutTime: null,
          workingHours: 0,
          otHours: 0,
        };
      } else {
        // Working days normally require valid in/out times. If both are empty,
        // treat the day as an unpaid "No Pay" day with zero hours instead of failing.
        const rawIn = row[inTimeIdx];
        const rawOut = row[outTimeIdx];

        const isEmptyCell = (v) =>
          v == null || (typeof v === "string" && v.trim() === "");

        if (isEmptyCell(rawIn) && isEmptyCell(rawOut)) {
          payload = {
            status: "No Pay",
            dayType: finalDayType,
            checkInTime: null,
            checkOutTime: null,
            workingHours: 0,
            otHours: 0,
          };
        } else {
          const checkInTime = parseTimeToDate(dateStr, rawIn);
          const checkOutTime = parseTimeToDate(dateStr, rawOut);

          if (!checkInTime || !checkOutTime) {
            throw new Error(`Invalid in time or out time on row ${i + 1}`);
          }

          const diffMs = checkOutTime.getTime() - checkInTime.getTime();
          if (diffMs < 0) {
            throw new Error(`Out time is earlier than in time on row ${i + 1}`);
          }

          const workingHours = diffMs / (1000 * 60 * 60);

          const { dayWorkingHours, otHours } = await calculateWorkingAndOtHours(
            dateStr,
            finalStatus,
            finalDayType,
            workingHours
          );

          payload = {
            status: finalStatus,
            dayType: finalDayType,
            checkInTime,
            checkOutTime,
            workingHours: Number(dayWorkingHours.toFixed(2)),
            otHours: Number(otHours.toFixed(2)),
          };
        }
      }

      if (existing) {
        await existing.update(payload);
        updatedCount += 1;
      } else {
        await Attendance.create({
          employeeId,
          date: dateStr,
          ...payload,
        });
        createdCount += 1;
      }
    }

    res.status(200).json({
      message: "Attendance Excel uploaded successfully",
      created: createdCount,
      updated: updatedCount,
    });
  } catch (err) {
    console.error("Error uploading attendance Excel:", err);

    if (err.statusCode === 403) {
      res.status(403).json({ message: "Only admins can perform this action" });
      return;
    }

    res.status(500).json({ message: err.message || "Failed to upload attendance Excel" });
  }
}

export async function getEmployeeMonthlyAttendance(req, res) {
  try {
    ensureAdmin(req);

    const { employeeId } = req.params;
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
    const month = req.query.month ? Number(req.query.month) : new Date().getMonth() + 1; // 1-12

    if (!employeeId) {
      res.status(400).json({ message: "employeeId is required" });
      return;
    }

    const employee = await Employee.findByPk(employeeId);
    if (!employee) {
      res.status(404).json({ message: "Employee not found" });
      return;
    }

    const { startDate, endDate } = getPayrollCycleRange(year, month);

    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    const records = await Attendance.findAll({
      where: {
        employeeId,
        date: {
          [Op.between]: [startStr, endStr],
        },
      },
      order: [["date", "ASC"]],
    });

    let totalWorkingHours = 0;
    let totalOtHours = 0;
    let annualLeaveDays = 0;
    let sickLeaveDays = 0;
    let noPayDays = 0;

    records.forEach((rec) => {
      totalWorkingHours += Number(rec.workingHours || 0);
      totalOtHours += Number(rec.otHours || 0);

      if (rec.status === "Annual Leave") {
        annualLeaveDays += 1;
      } else if (rec.status === "Sick Leave") {
        sickLeaveDays += 1;
      } else if (rec.status === "No Pay") {
        noPayDays += 1;
      }
    });

    totalWorkingHours = Number(totalWorkingHours.toFixed(2));
    totalOtHours = Number(totalOtHours.toFixed(2));

    const summary = {
      employee: {
        employeeId: employee.employeeId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        baseSalary: employee.baseSalary,
      },
      period: {
        year,
        month,
        startDate: startStr,
        endDate: endStr,
      },
      totals: {
        workingHours: totalWorkingHours,
        otHours: totalOtHours,
        annualLeaveDays,
        sickLeaveDays,
        noPayDays,
      },
      records,
    };

    res.json(summary);
  } catch (err) {
    console.error("Error fetching monthly attendance:", err);
    res.status(err.statusCode || 500).json({
      message: err.statusCode === 403 ? "Only admins can perform this action" : "Failed to fetch attendance",
    });
  }
}

export async function getAllEmployeesLeaveSummary(req, res) {
  try {
    ensureAdmin(req);

    const year = req.query.year ? Number(req.query.year) : null;
    const month = req.query.month ? Number(req.query.month) : null; // 1-12

    const where = {
      status: {
        [Op.in]: ["Annual Leave", "Sick Leave", "No Pay"],
      },
    };

    let period = null;

    if (year && month) {
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0);

      const startStr = startDate.toISOString().slice(0, 10);
      const endStr = endDate.toISOString().slice(0, 10);

      where.date = {
        [Op.between]: [startStr, endStr],
      };

      period = {
        year,
        month,
        startDate: startStr,
        endDate: endStr,
      };
    }

    const [employees, records] = await Promise.all([
      Employee.findAll(),
      Attendance.findAll({ where, order: [["employeeId", "ASC"], ["date", "ASC"]] }),
    ]);

    const employeeMap = {};
    employees.forEach((emp) => {
      employeeMap[emp.employeeId] = {
        employeeId: emp.employeeId,
        firstName: emp.firstName,
        lastName: emp.lastName,
      };
    });

    const summaryByEmployee = {};

    records.forEach((rec) => {
      const empId = rec.employeeId;
      if (!summaryByEmployee[empId]) {
        const info = employeeMap[empId] || { employeeId: empId };
        summaryByEmployee[empId] = {
          employeeId: info.employeeId,
          firstName: info.firstName || null,
          lastName: info.lastName || null,
          annualLeaveDays: 0,
          sickLeaveDays: 0,
          noPayDays: 0,
        };
      }

      if (rec.status === "Annual Leave") {
        summaryByEmployee[empId].annualLeaveDays += 1;
      } else if (rec.status === "Sick Leave") {
        summaryByEmployee[empId].sickLeaveDays += 1;
      } else if (rec.status === "No Pay") {
        summaryByEmployee[empId].noPayDays += 1;
      }
    });

    res.json({
      period,
      employees: Object.values(summaryByEmployee),
    });
  } catch (err) {
    console.error("Error fetching leaves summary:", err);
    res.status(err.statusCode || 500).json({
      message: err.statusCode === 403 ? "Only admins can perform this action" : "Failed to fetch leaves summary",
    });
  }
}

export async function getSingleEmployeeLeaveSummary(req, res) {
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

    const year = req.query.year ? Number(req.query.year) : null;
    const month = req.query.month ? Number(req.query.month) : null; // 1-12

    const where = {
      employeeId,
      status: {
        [Op.in]: ["Annual Leave", "Sick Leave", "No Pay"],
      },
    };

    let period = null;

    if (year && month) {
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0);

      const startStr = startDate.toISOString().slice(0, 10);
      const endStr = endDate.toISOString().slice(0, 10);

      where.date = {
        [Op.between]: [startStr, endStr],
      };

      period = {
        year,
        month,
        startDate: startStr,
        endDate: endStr,
      };
    }

    const records = await Attendance.findAll({ where, order: [["date", "ASC"]] });

    let annualLeaveDays = 0;
    let sickLeaveDays = 0;
    let noPayDays = 0;

    records.forEach((rec) => {
      if (rec.status === "Annual Leave") {
        annualLeaveDays += 1;
      } else if (rec.status === "Sick Leave") {
        sickLeaveDays += 1;
      } else if (rec.status === "No Pay") {
        noPayDays += 1;
      }
    });

    res.json({
      employee: {
        employeeId: employee.employeeId,
        firstName: employee.firstName,
        lastName: employee.lastName,
      },
      period,
      totals: {
        annualLeaveDays,
        sickLeaveDays,
        noPayDays,
      },
      records,
    });
  } catch (err) {
    console.error("Error fetching employee leave summary:", err);
    res.status(err.statusCode || 500).json({
      message:
        err.statusCode === 403
          ? "Only admins can perform this action"
          : "Failed to fetch employee leave summary",
    });
  }
}
