import "dotenv/config";
import app from "./app.js";
import { connectDB, sequelize } from "./config/db.js";
import { startSlaWatcher } from "./modules/notification/service/slaWatcher.js";
import { closeAllStreams, startStreamBus, stopStreamBus } from "./modules/notification/service/notificationStream.js";
import logger from "./utils/logger.js";

const PORT = process.env.PORT || 8000;
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

// How long in-flight requests get to finish after SIGTERM/SIGINT before the
// process exits anyway. Keep it below the platform's kill timeout (Docker and
// DigitalOcean App Platform both default to about 30 s).
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 10000;

let server;
let stopSlaWatcher = () => {};
let shuttingDown = false;

// Stops taking new connections, lets running requests finish, ends the
// notification streams (they never finish on their own and would hold the
// server open), then closes the database pool.
const shutdown = async (reason, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Shutting down (${reason})`);

    const force = setTimeout(() => {
        logger.error(`Shutdown did not finish within ${SHUTDOWN_GRACE_MS} ms — exiting`);
        process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    try {
        stopSlaWatcher();
        await stopStreamBus();
        if (server) {
            const closed = new Promise((resolve) => server.close(resolve));
            server.closeIdleConnections?.(); // keep-alive sockets with no request on them
            closeAllStreams();
            await closed;
        }
        await sequelize.close();
    } catch (err) {
        logger.error(`Error during shutdown: ${err.stack ?? err.message}`);
        exitCode = exitCode || 1;
    }
    // The winston file transports flush on the next tick; give them it.
    setTimeout(() => process.exit(exitCode), 100);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// A rejection nobody awaited is a bug, but one request's bug should not take
// the whole API down: log it and carry on. An uncaught exception leaves the
// process in an unknown state, so log it and exit — the process manager
// (systemd, pm2, Docker restart policy) starts a clean one.
process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled promise rejection: ${reason?.stack ?? reason}`);
});
process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception: ${err.stack ?? err.message}`);
    shutdown("uncaughtException", 1);
});

const start = async () => {
    await connectDB();
    server = app.listen(PORT, () => {
        console.log(`✅ Server is running on ${BACKEND_URL}`);
    });
    // Port already in use, no permission to bind, and the like.
    server.on("error", (err) => {
        logger.error(`Server failed to listen on port ${PORT}: ${err.message}`);
        shutdown("listen error", 1);
    });
    // Hears notifications raised by the other instances (see notificationStream.js).
    startStreamBus();
    // Raises the "past SLA" notifications; see SLA_CHECK_INTERVAL_MINUTES.
    stopSlaWatcher = startSlaWatcher();
};

start().catch((err) => {
    logger.error(`Startup failed: ${err.stack ?? err.message}`);
    shutdown("startup failed", 1);
});
