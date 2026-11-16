// Lets a route accept scoped tokens as well as a full session token. The
// token itself still goes through tokenValidator; this only declares which
// scopes the route is for (see utils/jwt.js — the PIN and password set-up
// tokens).
//
//   router.post("/me/pin", allowTokenScope(PIN_SETUP_SCOPE), tokenValidator, setMyPin)
//   router.get("/me", allowTokenScope(PIN_SETUP_SCOPE, PASSWORD_SETUP_SCOPE), tokenValidator, me)
export const allowTokenScope = (...scopes) => (req, res, next) => {
    req.tokenScope = scopes[0];
    req.tokenScopes = scopes;
    return next();
};

export default allowTokenScope;
