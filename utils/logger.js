import winston from "winston";

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

// Files get structured JSON (machine-readable, safe to ship to a log platform);
// the console gets a compact human format for the terminal.
const consoleFormat = combine(
    colorize({ level: true }),
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    printf(({ timestamp, level, message, stack }) => `[${timestamp}] ${level}: ${stack ?? message}`)
);

const logger = winston.createLogger({
    level: "info",
    format: combine(timestamp(), errors({ stack: true }), json()),
    transports: [
        new winston.transports.File({ filename: "logs/error.log", level: "error" }),
        new winston.transports.File({ filename: "logs/combined.log" }),
    ],
});

if (process.env.NODE_ENV !== "production") {
    logger.add(new winston.transports.Console({ format: consoleFormat }));
}

export default logger;
