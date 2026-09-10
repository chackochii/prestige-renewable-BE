// Lets a file URL carry a token as ?token=… so <img src> and plain links
// (which cannot set an Authorization header) can load protected documents.
// Runs before tokenValidator, which then verifies it as usual. The route is
// marked with the "download" scope so a download-only token (see
// utils/jwt.signDownloadToken) is accepted here and nowhere else; a full
// session token still works too.
export const tokenFromQuery = (req, res, next) => {
    req.tokenScope = "download";
    if (!req.headers.authorization && typeof req.query.token === "string" && req.query.token)
        req.headers.authorization = `Bearer ${req.query.token}`;
    return next();
};

export default tokenFromQuery;
