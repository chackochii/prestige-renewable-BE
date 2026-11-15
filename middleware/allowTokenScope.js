// Lets a route accept a scoped token as well as a full session token. The
// token itself still goes through tokenValidator; this only declares which
// scope the route is for (see utils/jwt.js — the PIN set-up token).
//
//   router.post("/me/pin", allowTokenScope(PIN_SETUP_SCOPE), tokenValidator, setMyPin)
export const allowTokenScope = (scope) => (req, res, next) => {
    req.tokenScope = scope;
    return next();
};

export default allowTokenScope;
