import express from "express";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import cors from "cors";
import bcrypt from "bcrypt";
import userRouter from "./routes/userRouter.js";
import employeeRouter from "./routes/employeeRouter.js";
import attendanceRouter from "./routes/attendanceRouter.js";
import payrollRouter from "./routes/payrollRouter.js";
import holidayRouter from "./routes/holidayRouter.js";
import sequelize from "./db.js";
import User from "./models/User.js";

dotenv.config();

const app = express();

// Allow requests from the Vite dev server and other frontends
app.use(
    cors({
        origin: [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:5174",
            "http://127.0.0.1:5174",
        ],
    })
);

app.use(express.json());


// JWT middleware for protected routes below

app.use((req, res, next) => {
    const authorizationHeader = req.header("Authorization");

    if (authorizationHeader != null) {
        let token = authorizationHeader;
        if (authorizationHeader.startsWith("Bearer ")) {
            token = authorizationHeader.slice(7);
        }
        console.log(token);
        jwt.verify(token, process.env.JWT_SECRET_KEY, (error, content) => {
            if (error || !content) {
                res.status(401).json({
                    message: "Invalid token",
                });
                return;
            } else {
                req.user = content;
                next();
            }
            console.log(content);
        });
    } else {
        next();
    }
});
// Public user routes
app.use("/users", userRouter);

// All employee routes require a valid JWT; admin check happens in the controller
app.use("/employees", employeeRouter);

// Attendance routes (admin-protected in controller)
app.use("/attendance", attendanceRouter);

// Payroll routes (admin-protected in controller)
app.use("/payroll", payrollRouter);

// Holiday routes (admin-protected in controller)
app.use("/holidays", holidayRouter);

sequelize
    .authenticate()
    .then(() => {
        console.log("Connected to MySQL database");
        // Keep database schema in sync with models (adds/changes columns like workingHours, otHours, etc.)
        return sequelize.sync({ alter: true });
    })
    .then(async () => {
        // Seed default admin user if not present
        const adminEmail = "linuka@gmail.com";
        const adminPassword = "linu123";

        try {
            const existingAdmin = await User.findOne({ where: { email: adminEmail } });

            if (!existingAdmin) {
                const hashedPassword = await bcrypt.hash(adminPassword, 10);

                await User.create({
                    email: adminEmail,
                    firstName: "Admin",
                    lastName: "User",
                    password: hashedPassword,
                    role: "Admin",
                    isEmailVerified: true,
                    isBlocked: false,
                });

                console.log("Default admin user created:", adminEmail);
            } else {
                console.log("Default admin user already exists:", adminEmail);
            }
        } catch (seedError) {
            console.error("Failed to seed default admin user:", seedError);
        }
    })
    .then(() => {
        app.listen(3000, () => {
            console.log("server is running on port 3000");
        });
    })
    .catch((err) => {
        console.error("Unable to connect to the database:", err);
    });
