import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import routes from "./routes/index.js";
import errorHandler from "./middleware/errorHandler.js";
import { errorResponse } from "./utils/apiResponse.js";
import { redactUrl } from "./utils/redact.js";
import { sequelize } from "./config/db.js";
import logger from "./utils/logger.js";

const app = express();

// Behind nginx or a load balancer every connection arrives from the proxy, so
// req.ip — what the rate limiters count per — would be the proxy's address and
// all visitors would share one bucket. TRUST_PROXY is the number of proxy hops
// in front of the app (1 = a single nginx / DigitalOcean load balancer), and
// req.ip then becomes the client address from X-Forwarded-For. It must match
// the real hop count: set too high, a client can forge the header and dodge
// the limits. Left unset it is 1 in production and off (direct connections)
// otherwise.
const trustProxy = process.env.TRUST_PROXY?.trim() || (process.env.NODE_ENV === "production" ? "1" : "false");
app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === "true" ? true : trustProxy === "false" ? false : trustProxy);

// Security headers (helmet also removes X-Powered-By). The API serves JSON and
// files, never pages, so helmet's default CSP is fine; the file routes set a
// stricter one of their own. Two settings differ from the defaults:
//  - Cross-Origin-Resource-Policy: the frontend lives on another origin and
//    loads protected files through <img src>/links, which "same-origin" blocks.
//  - HSTS: production only, and only when the site is served over HTTPS — it
//    tells browsers to refuse plain HTTP for a year, so a plain-HTTP staging
//    box must not send it (HSTS=false turns it off).
app.use(
    helmet({
        crossOriginResourcePolicy: { policy: "cross-origin" },
        strictTransportSecurity:
            process.env.NODE_ENV === "production" && process.env.HSTS !== "false"
                ? { maxAge: 31536000, includeSubDomains: true }
                : false,
    })
);
app.use(cors());
// A site-visit report carries drawn signatures as PNG data URLs, which outgrow
// the 100 kB default. Only that public route gets the larger allowance; the
// general parser below then leaves an already-parsed body alone.
app.use("/api/public/site-visits", express.json({ limit: "1mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// The file and notification-stream routes carry a token in the query string;
// the request log must not keep it (see utils/redact.js).
morgan.token("url", (req) => redactUrl(req.originalUrl || req.url));
// Request log. Development keeps morgan's short coloured line on the console.
// Production writes one JSON line per request through the logger (so it
// reaches stdout and the rotating files): client address, method, redacted
// URL, status, size, time and user agent. The Referer header is deliberately
// left out — it is the frontend page the request came from, and for the
// site-visit and proposal pages that URL carries the link token. /health is
// skipped: a load balancer polls it every few seconds.
if (process.env.NODE_ENV === "production") {
    const accessLine = (tokens, req, res) =>
        JSON.stringify({
            message: "request",
            ip: req.ip,
            method: req.method,
            url: tokens.url(req, res),
            status: Number(tokens.status(req, res)) || null,
            bytes: Number(tokens.res(req, res, "content-length")) || 0,
            ms: Math.round(Number(tokens["response-time"](req, res)) || 0),
            userAgent: req.headers["user-agent"] ?? null,
        });
    app.use(
        morgan(accessLine, {
            skip: (req) => req.path === "/health",
            stream: { write: (line) => logger.info(JSON.parse(line)) },
        })
    );
} else {
    app.use(morgan("dev"));
}

// Health check for the load balancer / process manager: 200 only when the
// database answers a SELECT 1 within HEALTH_DB_TIMEOUT_MS, 503 otherwise, so a
// dead connection takes the instance out of rotation instead of serving 500s.
// The reason is logged, never returned — this route is unauthenticated.
const HEALTH_DB_TIMEOUT_MS = Number(process.env.HEALTH_DB_TIMEOUT_MS) || 3000;
app.get("/health", async (req, res) => {
    let timer;
    try {
        await Promise.race([
            sequelize.query("SELECT 1"),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`no answer within ${HEALTH_DB_TIMEOUT_MS} ms`)), HEALTH_DB_TIMEOUT_MS);
            }),
        ]);
        res.json({ status: "ok" });
    } catch (err) {
        logger.error(`Health check failed — database: ${err.message}`);
        res.status(503).json({ status: "unavailable" });
    } finally {
        clearTimeout(timer);
    }
});
app.use("/api", routes);

app.use((req, res) => errorResponse(res, "Route not found", 404));
app.use(errorHandler);

export default app;
