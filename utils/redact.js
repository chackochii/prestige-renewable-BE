// Some routes carry a credential in the URL because the browser cannot set a
// header on them: <img>/<a> links to files and the EventSource notification
// stream take it as ?token=…, and the public site-visit form carries its token
// in the path. A URL like that must never reach a log — request logs, error
// logs and anything shipped to a log platform are read by more people, and kept
// far longer, than the token's own lifetime.
//
// Anything that logs a URL should pass it through here first.

const SENSITIVE_PARAMS = ["token", "access_token", "password", "secret", "key", "signature"];
const QUERY_PATTERN = new RegExp(`([?&](?:${SENSITIVE_PARAMS.join("|")})=)[^&\\s]+`, "gi");

// Path segments that are themselves the credential: /site-visits/<token>.
const PATH_PATTERN = /(\/site-visits\/)[^/?#\s]+/gi;

/** The URL with any credential-bearing query value or path segment replaced. */
export const redactUrl = (url) =>
    String(url ?? "")
        .replace(QUERY_PATTERN, "$1REDACTED")
        .replace(PATH_PATTERN, "$1REDACTED");

export default redactUrl;
