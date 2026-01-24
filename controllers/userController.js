import User from "../models/User.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

function ensureAdmin(req) {
  const role = req.user && req.user.role ? String(req.user.role).toLowerCase() : null;

  if (!role || (role !== "admin" && role !== "manager")) {
    const error = new Error("Forbidden");
    error.statusCode = 403;
    throw error;
  }
}

async function createUser(req, res) {
  try {
    const data = req.body;

    const hashedPassword = bcrypt.hashSync(data.password, 10);

    await User.create({
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      password: hashedPassword,
      role: data.role,
    });

    res.json({ message: "User created successfully" });
  } catch (error) {
    console.error("Error creating user:", error);
    res.status(500).json({ message: "Failed to create user" });
  }
}

export async function getAllUsers(req, res) {
  try {
    ensureAdmin(req);

    const users = await User.findAll({
      attributes: { exclude: ["password"] },
      order: [["createdAt", "DESC"]],
    });

    res.json(users);
  } catch (error) {
    console.error("Error fetching users:", error);

    if (error.statusCode === 403) {
      res.status(403).json({ message: "Only admins can perform this action" });
      return;
    }

    res.status(500).json({ message: "Failed to fetch users" });
  }
}

export async function toggleBlockUser(req, res) {
  try {
    ensureAdmin(req);

    const { email } = req.params;
    const { isBlocked } = req.body || {};

    if (!email) {
      res.status(400).json({ message: "Email is required" });
      return;
    }

    const user = await User.findOne({ where: { email } });

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    const newBlockedState =
      typeof isBlocked === "boolean" ? isBlocked : !Boolean(user.isBlocked);

    user.isBlocked = newBlockedState;
    await user.save();

    res.json({
      message: `User ${newBlockedState ? "blocked" : "unblocked"} successfully`,
      isBlocked: newBlockedState,
    });
  } catch (error) {
    console.error("Error toggling user block state:", error);

    if (error.statusCode === 403) {
      res.status(403).json({ message: "Only admins can perform this action" });
      return;
    }

    res.status(500).json({ message: "Failed to update user status" });
  }
}

export async function loginUser(req, res) {
  try {
    const email = req.body.email;
    const password = req.body.password;

    const user = await User.findOne({ where: { email } });

    if (!user) {
      res.json({
        message: "User not found",
      });
      return;
    }

    if (user.isBlocked) {
      res.status(403).json({ message: "User is blocked" });
      return;
    }

    const isPasswordCorrect = bcrypt.compareSync(password, user.password);

    if (!isPasswordCorrect) {
      res.json({
        message: "Incorrect password",
      });
      return;
    }

    const payload = {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
      image: user.image,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET_KEY);

    res.json({
      message: "Login successful",
      token: token,
      role: user.role,
    });
  } catch (error) {
    console.error("Error logging in:", error);
    res.status(500).json({ message: "Login failed" });
  }
}

export async function getCurrentUser(req, res) {
  try {
    if (!req.user) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    res.json(req.user);
  } catch (error) {
    console.error("Error getting current user:", error);
    res.status(500).json({ message: "Failed to get current user" });
  }
}

export { createUser };