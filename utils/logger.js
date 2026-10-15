import path from "node:path";
import winston from "winston";

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

// Where output goes:
//  - development: a compact human format on the console, plus the log files.
//  - production: JSON on stdout, which is what a platform (Docker, App
//    Platform, systemd/journald, a log shipper) collects, plus the log files
//    unless LOG_TO_FILES=false — set that when the platform keeps the output
//    and the disk should stay untouched.
//
// The files rotate: at LOG_MAX_SIZE_MB (default 10) the file is renumbered
// (combined1.log, combined2.log …) and only the newest LOG_MAX_FILES (default
// 5) are kept, so the logs/ folder is bounded at about
// 2 files × 5 × 10 MB. Never commit or ship the folder (it is in .gitignore):
// it holds real request data.
const consoleFormat = combine(
    colorize({ level: true }),
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    printf(({ timestamp, level, message, stack }) => `[${timestamp}] ${level}: ${stack ?? message}`)
);

const isProduction = process.env.NODE_ENV === "production";
const logDir = process.env.LOG_DIR || "logs";
const maxsize = (Number(process.env.LOG_MAX_SIZE_MB) || 10) * 1024 * 1024;
const maxFiles = Number(process.env.LOG_MAX_FILES) || 5;
const rotating = { maxsize, maxFiles, tailable: false };

const transports = [];
if (process.env.LOG_TO_FILES !== "false") {
    transports.push(
        new winston.transports.File({ filename: path.join(logDir, "error.log"), level: "error", ...rotating }),
        new winston.transports.File({ filename: path.join(logDir, "combined.log"), ...rotating })
    );
}
transports.push(
    new winston.transports.Console(isProduction ? { format: combine(timestamp(), errors({ stack: true }), json()) } : { format: consoleFormat })
);

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || "info",
    format: combine(timestamp(), errors({ stack: true }), json()),
    transports,
});

export default logger;
