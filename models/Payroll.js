import { DataTypes } from "sequelize";
import sequelize from "../db.js";

const Payroll = sequelize.define(
  "Payroll",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    employeeId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    year: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    month: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    baseSalary: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    totalWorkingHours: {
      type: DataTypes.DECIMAL(7, 2),
      defaultValue: 0,
    },
    totalOtHours: {
      type: DataTypes.DECIMAL(7, 2),
      defaultValue: 0,
    },
    annualLeaveDays: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    sickLeaveDays: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    noPayDays: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    otRate: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    otPay: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    noPayDeduction: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    epfDeduction: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    etfDeduction: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    incentive: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    netSalary: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
  },
  {
    tableName: "payrolls",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["employeeId", "year", "month"],
      },
    ],
  }
);

export default Payroll;
