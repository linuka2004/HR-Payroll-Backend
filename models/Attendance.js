import { DataTypes } from "sequelize";
import sequelize from "../db.js";

const Attendance = sequelize.define(
  "Attendance",
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
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("Present", "Annual Leave", "Sick Leave", "No Pay"),
      allowNull: false,
    },
    dayType: {
      type: DataTypes.ENUM("Normal", "Sunday", "MercantileHoliday"),
      allowNull: false,
      defaultValue: "Normal",
    },
    checkInTime: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    checkOutTime: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    workingHours: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
    },
    otHours: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
    },
  },
  { tableName: "attendances", timestamps: true }
);

export default Attendance;