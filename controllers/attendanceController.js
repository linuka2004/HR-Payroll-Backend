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
  // Payroll/attendance cycle: 21st of previous month (inclusive) to 20th of given month (inclusive)
  // Example: year=2026, month=2 -> 2026-01-21 to 2026-02-20
  const cycleEnd = new Date(year, month - 1, 20);
  const cycleStart = new Date(year, month - 2, 21);

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
    // On Sundays and Mercantile holidays, employees get double OT for worked hours
    // and no normal working hours are counted.
    dayWorkingHours = 0;
    if (finalDayType === "Sunday" || finalDayType === "MercantileHoliday") {
      otHours = Number((wh * 2).toFixed(2));
    } else {
      // For other special OT days (e.g., public holidays), keep existing behavior
      otHours = Number(wh.toFixed(2));
    }
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

    const dateOnly = date;

    const existing = await Attendance.findOne({ where: { employeeId, date: dateOnly } });

    // Adjust Annual Leave vs No Pay based on yearly annual leave entitlement.
    // This logic does NOT apply on Sundays or Mercantile holidays, since
    // absences on those days should not consume annual leave or cause salary deduction.
    if (finalDayType !== "Sunday" && finalDayType !== "MercantileHoliday") {
      const annualEntitlement = Number(employee.annualLeaveEntitlementDays || 0);
      if (annualEntitlement <= 0) {
        // No annual leave allocated: any attempted Annual Leave becomes No Pay
        if (finalStatus === "Annual Leave") {
          finalStatus = "No Pay";
        }
      } else {
        const parsedDateForYear = new Date(dateOnly);
        if (Number.isNaN(parsedDateForYear.getTime())) {
          res.status(400).json({ message: "Invalid date value" });
          return;
        }

        const year = parsedDateForYear.getFullYear();
        const yearStartStr = `${year}-01-01`;
        const yearEndStr = `${year}-12-31`;

        const whereAnnual = {
          employeeId,
          status: "Annual Leave",
          dayType: {
            [Op.notIn]: ["Sunday", "MercantileHoliday"],
          },
          date: {
            [Op.between]: [yearStartStr, yearEndStr],
          },
        };

        if (existing && existing.id) {
          whereAnnual.id = { [Op.ne]: existing.id };
        }

        const annualUsed = await Attendance.count({ where: whereAnnual });

        if (finalStatus === "Annual Leave") {
          // If entitlement already fully used, treat this as No Pay
          if (annualUsed >= annualEntitlement) {
            finalStatus = "No Pay";
          }
        } else if (finalStatus === "No Pay") {
          // If entitlement still available, automatically use Annual Leave instead of No Pay
          if (annualUsed < annualEntitlement) {
            finalStatus = "Annual Leave";
          }
        }
      }
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

      try {
        const result = await calculateWorkingAndOtHours(dateOnly, finalStatus, finalDayType, workingHours);
        dayWorkingHours = result.dayWorkingHours;
        otHours = result.otHours;
      } catch (err) {
        res.status(400).json({ message: err.message || "Invalid working hours" });
        return;
      }
    }

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

    const annualEntitlement = Number(employee.annualLeaveEntitlementDays || 0);

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

      // Apply annual leave entitlement logic: convert between Annual Leave and No Pay when needed.
      // This should not apply on Sundays or Mercantile holidays.
      if (
        (payload.status === "Annual Leave" || payload.status === "No Pay") &&
        payload.dayType !== "Sunday" &&
        payload.dayType !== "MercantileHoliday"
      ) {
        if (annualEntitlement <= 0) {
          // No annual leave allocated: any attempted Annual Leave becomes No Pay
          if (payload.status === "Annual Leave") {
            payload.status = "No Pay";
          }
        } else {
          const parsedDateForYear = new Date(dateStr);
          if (!Number.isNaN(parsedDateForYear.getTime())) {
            const year = parsedDateForYear.getFullYear();
            const yearStartStr = `${year}-01-01`;
            const yearEndStr = `${year}-12-31`;

            const whereAnnual = {
              employeeId,
              status: "Annual Leave",
              dayType: {
                [Op.notIn]: ["Sunday", "MercantileHoliday"],
              },
              date: {
                [Op.between]: [yearStartStr, yearEndStr],
              },
            };

            if (existing && existing.id) {
              whereAnnual.id = { [Op.ne]: existing.id };
            }

            const annualUsed = await Attendance.count({ where: whereAnnual });

            if (payload.status === "Annual Leave") {
              if (annualUsed >= annualEntitlement) {
                payload.status = "No Pay";
              }
            } else if (payload.status === "No Pay") {
              if (annualUsed < annualEntitlement) {
                payload.status = "Annual Leave";
              }
            }
          }
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
      attributes: [
        "id",
        "date",
        "status",
        "dayType",
        "checkInTime",
        "checkOutTime",
        "workingHours",
        "otHours",
      ],
      where: {
        employeeId,
        date: {
          [Op.between]: [startStr, endStr],
        },
      },
      order: [["date", "ASC"]],
    });

    // Yearly annual and sick leave usage for the selected year (calendar year)
    const yearStartStr = `${year}-01-01`;
    const yearEndStr = `${year}-12-31`;

    const yearlyAnnualLeaveDays = await Attendance.count({
      where: {
        employeeId,
        status: "Annual Leave",
        dayType: {
          [Op.notIn]: ["Sunday", "MercantileHoliday"],
        },
        date: {
          [Op.between]: [yearStartStr, yearEndStr],
        },
      },
    });
    const yearlySickLeaveDays = await Attendance.count({
      where: {
        employeeId,
        status: "Sick Leave",
        dayType: {
          [Op.notIn]: ["Sunday", "MercantileHoliday"],
        },
        date: {
          [Op.between]: [yearStartStr, yearEndStr],
        },
      },
    });

    let totalWorkingHours = 0;
    let totalOtHours = 0;
    let annualLeaveDays = 0;
    let sickLeaveDays = 0;
    let noPayDays = 0;

    records.forEach((rec) => {
      totalWorkingHours += Number(rec.workingHours || 0);
      totalOtHours += Number(rec.otHours || 0);

      // On Sundays and Mercantile holidays, absences should not
      // be treated as paid leave or no-pay deductions.
      if (rec.dayType === "Sunday" || rec.dayType === "MercantileHoliday") {
        return;
      }

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

    const simplifiedRecords = records.map((rec) => ({
      id: rec.id,
      date: rec.date,
      status: rec.status,
      dayType: rec.dayType,
      checkInTime: rec.checkInTime,
      checkOutTime: rec.checkOutTime,
      workingHours: rec.workingHours,
      otHours: rec.otHours,
    }));

    const annualEntitlement = Number(employee.annualLeaveEntitlementDays || 0);
    const sickEntitlement = Number(employee.sickLeaveEntitlementDays || 0);
    const remainingAnnualLeave = Math.max(annualEntitlement - yearlyAnnualLeaveDays, 0);
    const remainingSickLeave = Math.max(sickEntitlement - yearlySickLeaveDays, 0);

    const summary = {
      employee: {
        employeeId: employee.employeeId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        baseSalary: employee.baseSalary,
        annualLeaveEntitlementDays: annualEntitlement,
        sickLeaveEntitlementDays: sickEntitlement,
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
      records: simplifiedRecords,
      annualLeaveSummary: {
        year,
        entitlementDays: annualEntitlement,
        takenDays: yearlyAnnualLeaveDays,
        remainingDays: remainingAnnualLeave,
      },
      sickLeaveSummary: {
        year,
        entitlementDays: sickEntitlement,
        takenDays: yearlySickLeaveDays,
        remainingDays: remainingSickLeave,
      },
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
      dayType: {
        [Op.notIn]: ["Sunday", "MercantileHoliday"],
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
      dayType: {
        [Op.notIn]: ["Sunday", "MercantileHoliday"],
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
