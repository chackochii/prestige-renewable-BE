// Where a request came from, for the activity log (modules/activity). Set once
// per request as req.activity = { source, ip, userAgent } and passed by the
// controllers into the services that record changes.
//
//   source  "web" for the app (a browser user agent), "api" for anything else
//           with a bearer token (scripts, integrations). The app or an
//           integration may name itself with an X-Client-Source header
//           ("mobile", "import", …); public forms, webhooks and timers record
//           "public", "webhook" and "system" themselves.
import { oneLine } from "../utils/text.js";

const SOURCE_MAX = 30;
const SOURCE_RE = /^[a-z][a-z0-9_-]*$/;

export const sourceOf = (req) => {
    const declared = oneLine(req.headers["x-client-source"], SOURCE_MAX).toLowerCase();
    if (declared && SOURCE_RE.test(declared)) return declared;
    const agent = String(req.headers["user-agent"] ?? "");
    return /mozilla|chrome|safari|firefox|edg\//i.test(agent) ? "web" : "api";
};

export const activitySource = (req, res, next) => {
    req.activity = {
        source: sourceOf(req),
        ip: req.ip ?? null,
        userAgent: oneLine(req.headers["user-agent"], 300) || null,
    };
    return next();
};

export default activitySource;
