import express from "express";
import cors from "cors";
import morgan from "morgan";
import routes from "./routes/index.js";
import errorHandler from "./middleware/errorHandler.js";
import { errorResponse } from "./utils/apiResponse.js";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use("/api", routes);

app.use((req, res) => errorResponse(res, "Route not found", 404));
app.use(errorHandler);

export default app;
