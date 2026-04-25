const express = require("express");
const axios = require("axios");
const { requireInternal } = require("../middleware/internalAuth");
const { Appointment } = require("../models/Appointment");
const { notify } = require("../services/notifier");
const { releaseSlot } = require("../services/userClient");
const env = require("../config/env");

const router = express.Router();
router.use(requireInternal);

router.get("/stats", async (_req, res, next) => {
  try {
    const [totalAppointments, pending, accepted, rejected, completed, cancelled, activeDoctorIds] = await Promise.all([
      Appointment.countDocuments(),
      Appointment.countDocuments({ status: "PENDING" }),
      Appointment.countDocuments({ status: "ACCEPTED" }),
      Appointment.countDocuments({ status: "REJECTED" }),
      Appointment.countDocuments({ status: "COMPLETED" }),
      Appointment.countDocuments({ status: "CANCELLED" }),
      Appointment.distinct("doctorId", { status: { $in: ["PENDING", "ACCEPTED"] } })
    ]);
    res.json({
      totalAppointments,
      byStatus: { PENDING: pending, ACCEPTED: accepted, REJECTED: rejected, COMPLETED: completed, CANCELLED: cancelled },
      activeDoctors: activeDoctorIds.length
    });
  } catch (err) {
    next(err);
  }
});

router.get("/doctors/:doctorId/appointments", async (req, res, next) => {
  try {
    const appointments = await Appointment.find({ doctorId: req.params.doctorId }).sort({ startTime: -1 }).limit(200);
    res.json({ appointments });
  } catch (err) {
    next(err);
  }
});

router.get("/patients/:patientId/appointments", async (req, res, next) => {
  try {
    const appointments = await Appointment.find({ patientId: req.params.patientId }).sort({ startTime: -1 }).limit(200);
    res.json({ appointments });
  } catch (err) {
    next(err);
  }
});

router.post("/appointments/cancel-by-doctor/:doctorId", async (req, res, next) => {
  try {
    const doctorId = req.params.doctorId;
    const appts = await Appointment.find({
      doctorId,
      status: { $in: ["PENDING", "ACCEPTED"] }
    });

    const cancelled = [];
    for (const appt of appts) {
      appt.status = "CANCELLED";
      await appt.save();
      cancelled.push({
        patientId: appt.patientId,
        appointmentId: appt._id.toString(),
        slotId: appt.slotId || null,
        doctorId
      });

      if (appt.slotId) {
        await releaseSlot({ doctorId, slotId: appt.slotId, patientId: appt.patientId });
      }

      await notify({
        userId: appt.patientId,
        type: "APPOINTMENT_CANCELLED",
        message: `Your appointment on ${appt.startTime.toISOString()} was cancelled because the doctor is no longer available.`
      });
    }

    await axios.post(
      `${env.NOTIFICATION_SERVICE_URL}/internal/activity`,
      { actorUserId: doctorId, action: "DOCTOR_APPOINTMENTS_CANCELLED", details: { doctorId, count: cancelled.length } },
      { headers: { "x-internal-api-key": env.INTERNAL_API_KEY } }
    );

    res.json({ cancelled });
  } catch (err) {
    next(err);
  }
});

module.exports = { internalRoutes: router };
