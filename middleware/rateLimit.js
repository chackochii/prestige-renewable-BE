// Rate limiter for the unauthenticated routes (login, public forms, token
// links). Counts per client address — or per whatever `key` returns — in a
// fixed window.
//
// The counters live in Postgres (table rate_limits) so every API instance
// shares them: with several instances behind a load balancer a limit of 10 is
// 10, not 10 × instances. One atomic upsert per request, judged by the
// database clock. If the database cannot be reached — or RATE_LIMIT_STORE=memory
// — the request is counted in this process's memory instead: limits are then
// per instance, but a database blip never locks everyone out of login.
//
// When the API sits behind a reverse proxy, set TRUST_PROXY (see app.js) so
// req.ip is the client, not the proxy.
import { sequelize } from "../config/db.js";
import logger from "../utils/logger.js";
import { errorResponse } from "../utils/apiResponse.js";

const useDatabase = () => process.env.RATE_LIMIT_STORE !== "memory";

// Warn about a failing store once a minute, not once per request.
let lastWarning = 0;
const warnStoreDown = (err) => {
    if (Date.now() - lastWarning < 60000) return;
    lastWarning = Date.now();
    logger.warn(`Rate limiter: database store unavailable, counting in memory (${err.message})`);
};

let unnamed = 0;

/**
 * @param {{ name?: string, windowMs?: number, max?: number, message?: string, key?: (req) => string }} options
 *   name — identifies the limiter in the shared table, so two limiters never
 *   share a counter. Give each route's limiter its own; it is part of the key.
 *   key — what the limit counts per. Defaults to the client address; a route
 *   authorised by a token in its path counts per token instead, so one leaked
 *   link is bounded and people sharing an office address are not.
 */
export const rateLimit = ({
    name = `limiter-${(unnamed += 1)}`,
    windowMs = 15 * 60 * 1000,
    max = 10,
    message = "Too many requests, try again later.",
    key: keyOf = null,
} = {}) => {
    // In-memory fallback.
    const hits = new Map(); // key → { count, resetAt }
    const MAX_TRACKED = 10_000; // bound memory under a flood from many addresses

    const sweepMemory = () => {
        const now = Date.now();
        for (const [k, entry] of hits) if (entry.resetAt <= now) hits.delete(k);
        // Still too many live entries: drop the oldest (Map keeps insertion order).
        while (hits.size > MAX_TRACKED) hits.delete(hits.keys().next().value);
    };

    const countInMemory = (key) => {
        const now = Date.now();
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            if (hits.size >= MAX_TRACKED) sweepMemory();
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }
        entry.count += 1;
        return { count: entry.count, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
    };

    // Insert the row, or add one to it — or start a new window if the old one
    // ended — in a single statement, so concurrent requests cannot lose a count.
    const countInDatabase = async (key) => {
        const [rows] = await sequelize.query(
            `INSERT INTO rate_limits AS r (key, count, reset_at)
             VALUES (:key, 1, NOW() + (:windowMs * INTERVAL '1 millisecond'))
             ON CONFLICT (key) DO UPDATE SET
                 count = CASE WHEN r.reset_at <= NOW() THEN 1 ELSE r.count + 1 END,
                 reset_at = CASE WHEN r.reset_at <= NOW() THEN EXCLUDED.reset_at ELSE r.reset_at END
             RETURNING count, CEIL(EXTRACT(EPOCH FROM (r.reset_at - NOW()))) AS retry_after`,
            { replacements: { key, windowMs } }
        );
        return { count: Number(rows[0].count), retryAfterSeconds: Math.max(1, Number(rows[0].retry_after)) };
    };

    const sweepDatabase = async () => {
        try {
            await sequelize.query("DELETE FROM rate_limits WHERE reset_at < NOW() - INTERVAL '1 hour'");
        } catch {
            // The table may not exist yet or the database be down; the next sweep tries again.
        }
    };

    const timer = setInterval(() => {
        sweepMemory();
        if (useDatabase()) sweepDatabase();
    }, windowMs);
    timer.unref?.(); // never keep the process alive just for this

    return async (req, res, next) => {
        try {
            const client = (keyOf && keyOf(req)) || req.ip || req.socket?.remoteAddress || "unknown";
            const key = `${name}:${client}`.slice(0, 300);

            let result;
            if (useDatabase()) {
                try {
                    result = await countInDatabase(key);
                } catch (err) {
                    warnStoreDown(err);
                }
            }
            result ??= countInMemory(key);

            res.setHeader("X-RateLimit-Limit", String(max));
            res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - result.count)));
            if (result.count > max) {
                res.setHeader("Retry-After", String(result.retryAfterSeconds));
                return errorResponse(res, message, 429);
            }
            return next();
        } catch (err) {
            return next(err);
        }
    };
};

export default rateLimit;
