// Live delivery of notifications over Server-Sent Events: one open HTTP
// response per browser tab, held here in memory and written to whenever a
// notification is created for that user (see notificationService.notify).
//
// SSE rather than WebSocket because the traffic only ever goes one way — the
// browser's own EventSource handles reconnection, and no protocol upgrade or
// extra dependency is needed.
//
// In memory means per process: with more than one backend instance a user
// only receives events raised by the instance they are connected to. Moving
// publish() onto a shared bus (Redis pub/sub) is the upgrade path; nothing
// else here changes.

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

/** Sends one event to every connection this user has open. */
export const publish = (userId, event, data) => {
    const connections = clients.get(Number(userId));
    if (!connections?.size) return 0;
    let delivered = 0;
    for (const res of connections) {
        if (write(res, event, data)) delivered += 1;
        else connections.delete(res);
    }
    return delivered;
};

/** Open connections, for the health/debug view. */
export const streamStats = () => ({
    users: clients.size,
    connections: [...clients.values()].reduce((sum, set) => sum + set.size, 0),
});
