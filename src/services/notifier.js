const axios = require("axios");
const env = require("../config/env");

async function notify({ userId, type, message }) {
  await axios.post(
    `${env.NOTIFICATION_SERVICE_URL}/internal/notify`,
    { userId, type, message },
    { headers: { "x-internal-api-key": env.INTERNAL_API_KEY } }
  );
}

async function logActivity({ actorUserId, action, details }) {
  await axios.post(
    `${env.NOTIFICATION_SERVICE_URL}/internal/activity`,
    { actorUserId, action, details },
    { headers: { "x-internal-api-key": env.INTERNAL_API_KEY } }
  );
}

async function upsertMedicineReminder({ userId, appointmentId, medicines }) {
  await axios.post(
    `${env.NOTIFICATION_SERVICE_URL}/internal/reminders/medicine`,
    { userId, appointmentId, medicines },
    { headers: { "x-internal-api-key": env.INTERNAL_API_KEY } }
  );
}

async function upsertFollowUpReminder({ userId, appointmentId, dueAt }) {
  await axios.post(
    `${env.NOTIFICATION_SERVICE_URL}/internal/reminders/followup`,
    { userId, appointmentId, dueAt },
    { headers: { "x-internal-api-key": env.INTERNAL_API_KEY } }
  );
}

module.exports = { notify, logActivity, upsertMedicineReminder, upsertFollowUpReminder };

