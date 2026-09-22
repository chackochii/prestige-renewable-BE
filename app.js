import express from "express";
import cors from "cors";
import morgan from "morgan";
import routes from "./routes/index.js";
import errorHandler from "./middleware/errorHandler.js";
import { errorResponse } from "./utils/apiResponse.js";
import { redactUrl } from "./utils/redact.js";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// The file and notification-stream routes carry a token in the query string;
// the request log must not keep it (see utils/redact.js).
morgan.token("url", (req) => redactUrl(req.originalUrl || req.url));
app.use(morgan("dev"));

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use("/api", routes);

app.use((req, res) => errorResponse(res, "Route not found", 404));
app.use(errorHandler);

export default app;
