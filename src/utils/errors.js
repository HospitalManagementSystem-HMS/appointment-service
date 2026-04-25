function notFound(_req, res) {
  res.status(404).json({ error: "NOT_FOUND" });
}

function errorHandler(err, _req, res, _next) {
  // eslint-disable-next-line no-console
  console.error(err);

  if (err && err.name === "ZodError") {
    return res.status(400).json({ error: "VALIDATION_ERROR", details: err.issues });
  }
  return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
}

module.exports = { notFound, errorHandler };

