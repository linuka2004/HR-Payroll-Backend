import { Sequelize } from "sequelize";
import dotenv from "dotenv";

dotenv.config();

// Use explicit local defaults for user/password so OS-level env
// like DB_USER=payroll_user cannot break the dev connection.
const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    dialect: "mysql",
    logging: false,
  }
);

export default sequelize;
