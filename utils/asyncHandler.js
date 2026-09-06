// Wraps async route handlers so thrown/rejected errors reach the global
// error middleware instead of crashing the request.
export const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

export default asyncHandler;
