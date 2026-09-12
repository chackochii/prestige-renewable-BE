// Small in-memory rate limiter for the unauthenticated routes. Per-process
// and per-IP, which is enough to stop a form being hammered; put a shared
// limiter in front (proxy, gateway) if the API ever runs on several nodes.
// When the API sits behind a reverse proxy, set `app.set("trust proxy", 1)`
// so req.ip is the client, not the proxy.

/**
 * @param {{ windowMs?: number, max?: number, message?: string }} options
 */
export const rateLimit = ({ windowMs = 15 * 60 * 1000, max = 10, message = "Too many requests, try again later." } = {}) => {
    const hits = new Map(); // ip → { count, resetAt }
    const MAX_TRACKED = 10_000; // bound memory under a flood from many addresses

    const sweep = () => {
        const now = Date.now();
        for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
        // Still too many live entries: drop the oldest (Map keeps insertion order).
        while (hits.size > MAX_TRACKED) hits.delete(hits.keys().next().value);
    };
    const timer = setInterval(sweep, windowMs);
    timer.unref?.(); // never keep the process alive just for this

    return (req, res, next) => {
        const now = Date.now();
        const key = req.ip || req.socket?.remoteAddress || "unknown";
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            if (hits.size >= MAX_TRACKED) sweep();
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }
        entry.count += 1;
        res.setHeader("X-RateLimit-Limit", String(max));
        res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
        if (entry.count > max) {
            res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
            return res.status(429).json({ success: false, message });
        }
        return next();
    };
};

export default rateLimit;
