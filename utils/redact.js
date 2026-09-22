// Two routes carry a token in the query string because the browser cannot set
// a header on them: <img>/<a> links to files, and the EventSource notification
// stream. A URL like that must never reach a log — request logs, error logs
// and anything shipped to a log platform are read by more people, and kept far
// longer, than the token's own lifetime.
//
// Anything that logs a URL should pass it through here first.

const SENSITIVE_PARAMS = ["token", "access_token", "password", "secret", "key", "signature"];
const PATTERN = new RegExp(`([?&](?:${SENSITIVE_PARAMS.join("|")})=)[^&\\s]+`, "gi");

/** The URL with any credential-bearing query value replaced. */
export const redactUrl = (url) => String(url ?? "").replace(PATTERN, "$1REDACTED");

export default redactUrl;
