const env = require("../config/env");

function requireInternal(req, res, next) {
  const key = req.header("x-internal-api-key");
  if (!key || key !== env.INTERNAL_API_KEY) return res.status(401).json({ error: "UNAUTHORIZED" });
  return next();
}

module.exports = { requireInternal };
