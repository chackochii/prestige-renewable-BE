// Polls every active Meta connection for leads the webhook may have missed
// (the server was down, a delivery failed its retries) and imports leads
// that arrived before the connection was set up. Google Ads only pushes, so
// there is nothing to poll there. A plain interval like the SLA watcher:
// LEAD_SYNC_INTERVAL_MINUTES=0 turns it off.
import logger from "../../../utils/logger.js";
import { pollableConnections, syncConnection } from "./integrationConnectionService.js";

const DEFAULT_INTERVAL_MINUTES = 60;

/** One pass over the pollable connections. Returns how many new leads were filed. */
export const runLeadSync = async () => {
    const connections = await pollableConnections();
    let created = 0;
    for (const connection of connections) {
        try {
            const summary = await syncConnection(connection);
            created += summary.created;
        } catch (err) {
            // Recorded on the connection (lastError) for the screen; one line here.
            logger.warn(`Lead sync: connection ${connection.id} (${connection.name}) failed — ${err.message}`);
        }
    }
    return created;
};

export const startLeadSyncWatcher = () => {
    const minutes = Number(process.env.LEAD_SYNC_INTERVAL_MINUTES ?? DEFAULT_INTERVAL_MINUTES);
    if (!Number.isFinite(minutes) || minutes <= 0) {
        logger.info("Lead sync disabled (LEAD_SYNC_INTERVAL_MINUTES=0)");
        return () => {};
    }
    let running = false;
    const pass = async () => {
        if (running) return;
        running = true;
        try {
            const created = await runLeadSync();
            if (created) logger.info(`Lead sync: ${created} new lead(s) filed`);
        } catch (err) {
            logger.error(`Lead sync failed: ${err.name}: ${err.message}`);
        } finally {
            running = false;
        }
    };
    const timer = setInterval(pass, minutes * 60000);
    timer.unref();
    logger.info(`Lead sync running every ${minutes} minute(s); first pass in ${minutes} minute(s)`);
    return () => clearInterval(timer);
};
