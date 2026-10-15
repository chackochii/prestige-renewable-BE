// Live delivery of notifications over Server-Sent Events: one open HTTP
// response per browser tab, held here in memory and written to whenever a
// notification is created for that user (see notificationService.notify).
//
// SSE rather than WebSocket because the traffic only ever goes one way — the
// browser's own EventSource handles reconnection, and no protocol upgrade or
// extra dependency is needed.
//
// The open responses are per process, but the events are not: publish() also
// sends each event through Postgres (NOTIFY), and every instance listens
// (startStreamBus) and writes it to whichever of its own connections belong to
// that user. So a notification raised on instance A reaches a user connected
// to instance B, with no Redis or other service — the database is already the
// one thing every instance shares. Without startStreamBus (a script, a test) or
// while the listener is reconnecting, events still reach this process's own
// connections.
import crypto from "node:crypto";
import pg from "pg";
import { sequelize } from "../../../config/db.js";
import logger from "../../../utils/logger.js";

const CHANNEL = "prestige_notifications";
// Postgres refuses a NOTIFY payload of 8000 bytes or more.
const MAX_PAYLOAD_BYTES = 7500;
// Tells an instance which events it raised itself, so it does not deliver them twice.
const INSTANCE_ID = crypto.randomUUID();

const MAX_CONNECTIONS_PER_USER = 5;
const HEARTBEAT_MS = 25000;

/** userId → Set of open responses. */
const clients = new Map();

const write = (res, event, data) => {
    try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
    } catch {
        // The socket went away between the close event and this write.
        return false;
    }
};

// One timer for every connection, rather than one per client: a comment line
// keeps proxies from closing an idle stream.
const heartbeat = setInterval(() => {
    for (const connections of clients.values()) {
        for (const res of connections) {
            try {
                res.write(": ping\n\n");
            } catch {
                connections.delete(res);
            }
        }
    }
}, HEARTBEAT_MS);
heartbeat.unref();

/**
 * Registers an open SSE response for a user. Returns the unsubscribe function
 * the route must call when the request closes.
 */
export const subscribe = (userId, res) => {
    const key = Number(userId);
    if (!clients.has(key)) clients.set(key, new Set());
    const connections = clients.get(key);
    // A tab that never closed cleanly (laptop asleep, killed browser) can leave
    // a stale response behind; drop the oldest rather than growing forever.
    while (connections.size >= MAX_CONNECTIONS_PER_USER) {
        const oldest = connections.values().next().value;
        connections.delete(oldest);
        try {
            oldest.end();
        } catch {
            // already gone
        }
    }
    connections.add(res);

    return () => {
        const set = clients.get(key);
        if (!set) return;
        set.delete(res);
        if (!set.size) clients.delete(key);
    };
};

/** Writes one event to the connections this process holds for the user. */
const deliverLocal = (userId, event, data) => {
    const connections = clients.get(Number(userId));
    if (!connections?.size) return 0;
    let delivered = 0;
    for (const res of connections) {
        if (write(res, event, data)) delivered += 1;
        else connections.delete(res);
    }
    return delivered;
};

/**
 * Sends one event to every connection this user has open — on this instance
 * straight away, on the others through Postgres. Returns the number delivered
 * here; the broadcast is best effort and never throws.
 */
export const publish = (userId, event, data) => {
    const delivered = deliverLocal(userId, event, data);

    let payload = JSON.stringify({ origin: INSTANCE_ID, userId: Number(userId), event, data });
    // An oversized notification still has to arrive: drop the free text and let
    // the client fetch the rest from the inbox.
    if (Buffer.byteLength(payload) >= MAX_PAYLOAD_BYTES) {
        const { body, ...slim } = data ?? {};
        void body;
        payload = JSON.stringify({ origin: INSTANCE_ID, userId: Number(userId), event, data: slim });
    }
    if (Buffer.byteLength(payload) < MAX_PAYLOAD_BYTES)
        sequelize.query("SELECT pg_notify(:channel, :payload)", { replacements: { channel: CHANNEL, payload } }).catch((err) => {
            logger.warn(`Notification broadcast failed: ${err.message}`);
        });
    return delivered;
};

// ---- Cross-instance listener ------------------------------------------------
// LISTEN needs a connection of its own that stays open, so it does not come
// from the pool. If it drops it reconnects with backoff; events raised in the
// gap reach only users connected to the instance that raised them, and the
// inbox (a normal API read) still has them.

let listener = null;
let stopped = true;
let retryTimer = null;
let attempt = 0;

const onMessage = (message) => {
    if (message.channel !== CHANNEL) return;
    try {
        const { origin, userId, event, data } = JSON.parse(message.payload);
        if (origin !== INSTANCE_ID) deliverLocal(userId, event, data);
    } catch (err) {
        logger.warn(`Ignored a malformed notification broadcast: ${err.message}`);
    }
};

const connectListener = async () => {
    if (stopped) return;
    const { host, port, username, password, database } = sequelize.config;
    const ssl = sequelize.options.dialectOptions?.ssl;
    const client = new pg.Client({ host, port, user: username, password, database, ...(ssl ? { ssl } : {}) });
    const reconnect = () => {
        if (listener !== client) return;
        listener = null;
        client.removeAllListeners();
        client.on("error", () => {}); // a late error on a dead client must not crash the process
        client.end().catch(() => {});
        if (stopped) return;
        attempt += 1;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
        logger.warn(`Notification listener disconnected — retrying in ${delay / 1000}s`);
        retryTimer = setTimeout(connectListener, delay);
        retryTimer.unref();
    };
    try {
        listener = client;
        client.on("error", reconnect);
        client.on("end", reconnect);
        client.on("notification", onMessage);
        await client.connect();
        await client.query(`LISTEN ${CHANNEL}`);
        attempt = 0;
        logger.info("Notification listener connected");
    } catch (err) {
        logger.warn(`Notification listener could not connect: ${err.message}`);
        reconnect();
    }
};

/** Starts listening for events raised by the other instances. Call once, after the database is up. */
export const startStreamBus = () => {
    if (!stopped) return;
    stopped = false;
    return connectListener();
};

/** Stops listening (shutdown). */
export const stopStreamBus = async () => {
    stopped = true;
    clearTimeout(retryTimer);
    const client = listener;
    listener = null;
    if (client) {
        client.removeAllListeners();
        client.on("error", () => {});
        await client.end().catch(() => {});
    }
};

/** Open connections, for the health/debug view. */
export const streamStats = () => ({
    users: clients.size,
    connections: [...clients.values()].reduce((sum, set) => sum + set.size, 0),
});

/** Ends every open stream — shutdown only, so the server can finish closing. */
export const closeAllStreams = () => {
    clearInterval(heartbeat);
    for (const connections of clients.values()) {
        for (const res of connections) {
            try {
                res.end();
            } catch {
                // already gone
            }
        }
    }
    clients.clear();
};
