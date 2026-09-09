// Lets a file URL carry the session token as ?token=… so <img src> and plain
// links (which cannot set an Authorization header) can load protected
// documents. Runs before tokenValidator, which then verifies it as usual.
export const tokenFromQuery = (req, res, next) => {
    if (!req.headers.authorization && typeof req.query.token === "string" && req.query.token)
        req.headers.authorization = `Bearer ${req.query.token}`;
    return next();
};

export default tokenFromQuery;
