import db from "../config/db.js";

export async function generateMonthlyPayroll(employeeId, month) {
  // month format: YYYY-MM
  const [employeeRows] = await db.query(
    "SELECT baseSalary, otRate FROM employees WHERE id = ?",
    [employeeId]
  );

  if (!employeeRows.length) throw new Error("Employee not found");

  const { baseSalary, otRate } = employeeRows[0];

  // Attendance summary
  const [attendance] = await db.query(
    `
    SELECT 
      COUNT(*) AS working_days,
      IFNULL(SUM(ot_hours),0) AS total_ot
    FROM attendance_daily
    WHERE employee_id = ?
    AND DATE_FORMAT(date, '%Y-%m') = ?
    AND status = 'PRESENT'
    `,
    [employeeId, month]
  );

  // Leaves summary
  const [leaves] = await db.query(
    `
    SELECT
      SUM(leave_type='ANNUAL') AS annual,
      SUM(leave_type='SICK') AS sick,
      SUM(leave_type='NOPAY') AS nopay
    FROM leaves
    WHERE employee_id = ?
    AND DATE_FORMAT(date, '%Y-%m') = ?
    `,
    [employeeId, month]
  );

  const workingDays = attendance[0].working_days;
  const totalOT = attendance[0].total_ot;

  const annualLeaves = leaves[0].annual || 0;
  const sickLeaves = leaves[0].sick || 0;
  const nopayLeaves = leaves[0].nopay || 0;

  const dailySalary = baseSalary / 30;
  const otAmount = totalOT * otRate;
  const nopayDeduction = nopayLeaves * dailySalary;

  const netSalary = baseSalary + otAmount - nopayDeduction;

  // Save payroll
  await db.query(
    `
    INSERT INTO payroll_monthly
    (employee_id, month, working_days, total_ot_hours,
     annual_leaves, sick_leaves, nopay_leaves,
     base_salary, ot_amount, nopay_deduction, net_salary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      employeeId,
      month,
      workingDays,
      totalOT,
      annualLeaves,
      sickLeaves,
      nopayLeaves,
      baseSalary,
      otAmount,
      nopayDeduction,
      netSalary
    ]
  );

  return {
    employeeId,
    month,
    netSalary
  };
}
