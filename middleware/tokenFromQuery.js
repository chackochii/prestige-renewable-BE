// Lets a URL carry a token as ?token=… for the two places a browser cannot
// send an Authorization header: <img src>/links to protected documents, and
// the EventSource notification stream. Runs before tokenValidator, which then
// verifies it as usual.
//
// The route declares which scope it accepts — tokenValidator rejects a scoped
// token anywhere else (see utils/jwt.signDownloadToken / signStreamToken). A
// full session token still works on these routes too.
export const tokenFromQuery = (scope) => (req, res, next) => {
    req.tokenScope = scope;
    if (!req.headers.authorization && typeof req.query.token === "string" && req.query.token)
        req.headers.authorization = `Bearer ${req.query.token}`;
    return next();
};

export default tokenFromQuery;
