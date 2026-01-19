import express from "express";
import {
	createUser,
	loginUser,
	getCurrentUser,
	getAllUsers,
	toggleBlockUser,
} from "../controllers/userController.js";

const userRouter = express.Router();

userRouter.post("/", createUser);
userRouter.post("/login", loginUser);
userRouter.get("/", getCurrentUser);
userRouter.get("/all", getAllUsers);
userRouter.put("/toggle-block/:email", toggleBlockUser);

export default userRouter;