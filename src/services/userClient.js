const axios = require("axios");
const env = require("../config/env");

const headers = { "x-internal-api-key": env.INTERNAL_API_KEY };

async function lockSlot({ doctorId, slotId, patientId }) {
  const response = await axios.post(
    `${env.USER_SERVICE_URL}/internal/slots/lock`,
    { doctorId, slotId, patientId },
    { headers, validateStatus: () => true }
  );
  if (response.status >= 400) {
    return { ok: false, error: response.data?.error || "SLOT_UNAVAILABLE" };
  }
  return {
    ok: true,
    startTime: new Date(response.data.startTime),
    endTime: new Date(response.data.endTime)
  };
}

async function releaseSlot({ doctorId, slotId, patientId }) {
  try {
    await axios.post(`${env.USER_SERVICE_URL}/internal/slots/release`, { doctorId, slotId, patientId }, { headers, validateStatus: () => true });
  } catch {
    // best-effort
  }
}

async function setSlotAppointment({ doctorId, slotId, appointmentId }) {
  try {
    await axios.post(
      `${env.USER_SERVICE_URL}/internal/slots/set-appointment`,
      { doctorId, slotId, appointmentId },
      { headers, validateStatus: () => true }
    );
  } catch {
    // best-effort
  }
}

module.exports = { lockSlot, releaseSlot, setSlotAppointment };
