import { DataTypes } from "sequelize";
import sequelize from "../db.js";

const Employee = sequelize.define(
  "Employee",
  {
    employeeId: {
      type: DataTypes.STRING,
      allowNull: false,
      primaryKey: true,
      unique: true,
    },
    firstName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    lastName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    idNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    etfNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    telephone: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    department: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    address: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    role: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    image: {
      type: DataTypes.STRING,
      defaultValue: "/defaultProfile.png",
    },
    baseSalary: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    annualLeaveEntitlementDays: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    sickLeaveEntitlementDays: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    allowances: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    deductions: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
  },
  { timestamps: true, tableName: "employees" }
);

export default Employee;