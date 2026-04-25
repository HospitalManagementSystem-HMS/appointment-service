const axios = require("axios");
const env = require("../config/env");

async function lookupUsers(ids) {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return new Map();

  const resp = await axios.post(
    `${env.AUTH_SERVICE_URL}/internal/users/lookup`,
    { ids: unique },
    { headers: { "x-internal-api-key": env.INTERNAL_API_KEY } }
  );

  const map = new Map();
  for (const u of resp.data.users || []) map.set(u.id, u);
  return map;
}

module.exports = { lookupUsers };

