const express = require("express");
const { z } = require("zod");
const axios = require("axios");
const { Appointment } = require("../models/Appointment");
const { requireAuth, requireRole } = require("../middleware/requireAuth");
const { lookupUsers } = require("../services/authLookup");
const { notify, logActivity, upsertMedicineReminder, upsertFollowUpReminder } = require("../services/notifier");
const { lockSlot, releaseSlot, setSlotAppointment } = require("../services/userClient");
const env = require("../config/env");

const router = express.Router();

function toISOString(date) {
  return new Date(date).toISOString();
}

const scheduleEnum = z.enum(["MORNING", "NOON", "NIGHT"]);

const medicineInputSchema = z.object({
  name: z.string().min(1),
  instructions: z.string().min(1),
  schedule: z.array(scheduleEnum).min(1)
});

const bookLegacySchema = z.object({
  doctorId: z.string().min(1),
  startTime: z.string().datetime(),
  durationMinutes: z.number().int().positive().max(240).optional().default(30),
  problemDescription: z.string().max(600).optional().default("")
});

const bookSlotSchema = z.object({
  doctorId: z.string().min(1),
  slotId: z.string().min(1),
  problemDescription: z.string().max(600).optional().default("")
});

async function handleBookAppointment(req, res, next) {
  try {
    if (req.body?.slotId && String(req.body.slotId).trim() !== "") {
      const { doctorId, slotId, problemDescription } = bookSlotSchema.parse(req.body);
      const lock = await lockSlot({ doctorId, slotId, patientId: req.user.id });
      if (!lock.ok) return res.status(409).json({ error: lock.error || "SLOT_UNAVAILABLE" });

      const start = lock.startTime;
      const end = lock.endTime;
      if (new Date(start).getTime() < Date.now()) {
        await releaseSlot({ doctorId, slotId, patientId: req.user.id });
        return res.status(400).json({ error: "Invalid time selection" });
      }

      const overlap = await Appointment.findOne({
        doctorId,
        status: { $in: ["PENDING", "ACCEPTED"] },
        startTime: { $lt: end },
        endTime: { $gt: start }
      });
      if (overlap) {
        await releaseSlot({ doctorId, slotId, patientId: req.user.id });
        return res.status(409).json({ error: "SLOT_UNAVAILABLE" });
      }

      let appt;
      try {
        appt = await Appointment.create({
          doctorId,
          patientId: req.user.id,
          startTime: start,
          endTime: end,
          status: "PENDING",
          slotId,
          problemDescription: problemDescription || ""
        });
        await setSlotAppointment({ doctorId, slotId, appointmentId: appt._id.toString() });
      } catch (e) {
        await releaseSlot({ doctorId, slotId, patientId: req.user.id });
        throw e;
      }

      const refreshedUsers = await lookupUsers([doctorId, req.user.id]);
      const doctorEmail = refreshedUsers.get(doctorId)?.email || "doctor";
      const patientEmail = refreshedUsers.get(req.user.id)?.email || "patient";

      await notify({
        userId: doctorId,
        type: "APPOINTMENT_UPDATE",
        message: `New appointment request from ${patientEmail} for ${toISOString(start)} (slot locked).`
      });

      await notify({
        userId: req.user.id,
        type: "SLOT_BOOKED",
        message: `You booked a slot with ${doctorEmail} for ${toISOString(start)}.`
      });

      await logActivity({
        actorUserId: req.user.id,
        action: "APPOINTMENT_BOOKED",
        details: { appointmentId: appt._id.toString(), doctorId, startTime: appt.startTime, slotId }
      });
      
      try {
        await axios.post(
          `${env.API_GATEWAY_URL}/api/internal/emit`,
          { event: "appointment_updated", payload: { patientId: req.user.id, doctorId } },
          { headers: { "x-internal-api-key": env.INTERNAL_API_KEY }, timeout: 3000 }
        );
      } catch (e) {
        console.error(e.message);
      }

      return res.status(201).json({ appointment: appt });
    }

    const { doctorId, startTime, durationMinutes, problemDescription } = bookLegacySchema.parse(req.body);
    const start = new Date(startTime);
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

    if (start.getTime() < Date.now()) return res.status(400).json({ error: "Invalid time selection" });

    const overlap = await Appointment.findOne({
      doctorId,
      status: { $in: ["PENDING", "ACCEPTED"] },
      startTime: { $lt: end },
      endTime: { $gt: start }
    });

    if (overlap) return res.status(409).json({ error: "SLOT_UNAVAILABLE" });

    const appt = await Appointment.create({
      doctorId,
      patientId: req.user.id,
      startTime: start,
      endTime: end,
      status: "PENDING",
      problemDescription: problemDescription || ""
    });

    const refreshedUsers = await lookupUsers([doctorId, req.user.id]);
    const doctorEmail = refreshedUsers.get(doctorId)?.email || "doctor";
    const patientEmail = refreshedUsers.get(req.user.id)?.email || "patient";

    await notify({
      userId: doctorId,
      type: "APPOINTMENT_UPDATE",
      message: `New appointment request from ${patientEmail} for ${toISOString(start)}.`
    });

    await notify({
      userId: req.user.id,
      type: "SLOT_BOOKED",
      message: `You booked a slot with ${doctorEmail} for ${toISOString(start)}.`
    });

    await logActivity({
      actorUserId: req.user.id,
      action: "APPOINTMENT_BOOKED",
      details: { appointmentId: appt._id.toString(), doctorId, startTime: appt.startTime }
    });
    
    try {
      await axios.post(
        `${env.API_GATEWAY_URL}/api/internal/emit`,
        { event: "appointment_updated", payload: { patientId: req.user.id, doctorId } },
        { headers: { "x-internal-api-key": env.INTERNAL_API_KEY }, timeout: 3000 }
      );
    } catch (e) {
      console.error(e.message);
    }

    return res.status(201).json({ appointment: appt });
  } catch (err) {
    return next(err);
  }
}

router.post("/appointments", requireAuth, requireRole("PATIENT"), handleBookAppointment);
router.post("/appointment/book", requireAuth, requireRole("PATIENT"), handleBookAppointment);

router.get("/appointments/me", requireAuth, requireRole("PATIENT"), async (req, res, next) => {
  try {
    const appts = await Appointment.find({ patientId: req.user.id }).sort({ startTime: -1 });
    const doctorIds = appts.map((a) => a.doctorId);
    const users = await lookupUsers(doctorIds);
    return res.json({
      appointments: appts.map((a) => ({
        ...a.toObject(),
        doctorEmail: users.get(a.doctorId)?.email
      }))
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/doctor/appointments", requireAuth, requireRole("DOCTOR"), async (req, res, next) => {
  try {
    const appts = await Appointment.find({ doctorId: req.user.id }).sort({ startTime: -1 });
    const patientIds = appts.map((a) => a.patientId);
    const users = await lookupUsers(patientIds);
    return res.json({
      appointments: appts.map((a) => ({
        ...a.toObject(),
        patientEmail: users.get(a.patientId)?.email
      }))
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/admin/appointments", requireAuth, requireRole("ADMIN"), async (_req, res, next) => {
  try {
    const appts = await Appointment.find().sort({ createdAt: -1 }).limit(200);
    const ids = [];
    for (const a of appts) ids.push(a.doctorId, a.patientId);
    const users = await lookupUsers(ids);
    return res.json({
      appointments: appts.map((a) => ({
        ...a.toObject(),
        doctorEmail: users.get(a.doctorId)?.email,
        patientEmail: users.get(a.patientId)?.email
      }))
    });
  } catch (err) {
    next(err);
  }
});

const decisionSchema = z.object({
  status: z.enum(["ACCEPTED", "REJECTED"])
});

router.patch("/appointments/:id/decision", requireAuth, requireRole("DOCTOR"), async (req, res, next) => {
  try {
    const { status } = decisionSchema.parse(req.body);
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ error: "NOT_FOUND" });
    if (appt.doctorId !== req.user.id) return res.status(403).json({ error: "FORBIDDEN" });
    if (appt.status !== "PENDING") return res.status(409).json({ error: "INVALID_STATUS_TRANSITION" });

    appt.status = status;
    await appt.save();

    if (status === "REJECTED" && appt.slotId) {
      await releaseSlot({ doctorId: appt.doctorId, slotId: appt.slotId, patientId: appt.patientId });
    }

    const users = await lookupUsers([appt.doctorId, appt.patientId]);
    const doctorEmail = users.get(appt.doctorId)?.email || "doctor";
    const slotAware = Boolean(appt.slotId);

    await notify({
      userId: appt.patientId,
      type: status === "REJECTED" ? "SLOT_REJECTED" : "APPOINTMENT_UPDATE",
      message:
        status === "REJECTED" && slotAware
          ? `Your slot request with ${doctorEmail} for ${toISOString(appt.startTime)} was rejected. The slot is available again.`
          : status === "REJECTED"
            ? `Your appointment request with ${doctorEmail} for ${toISOString(appt.startTime)} was rejected.`
            : `Appointment with ${doctorEmail} for ${toISOString(appt.startTime)} was ${status}.`
    });

    await logActivity({
      actorUserId: req.user.id,
      action: "APPOINTMENT_DECISION",
      details: { appointmentId: appt._id.toString(), status }
    });
    
    try {
      await axios.post(
        `${env.API_GATEWAY_URL}/api/internal/emit`,
        { event: "appointment_updated", payload: { patientId: appt.patientId, doctorId: appt.doctorId } },
        { headers: { "x-internal-api-key": env.INTERNAL_API_KEY }, timeout: 3000 }
      );
    } catch (e) {
      console.error(e.message);
    }

    return res.json({ appointment: appt });
  } catch (err) {
    return next(err);
  }
});

const prescriptionBodySchema = z.object({
  medicines: z.array(medicineInputSchema).min(1),
  notes: z.string().optional().default("")
});

router.post("/appointments/:id/prescription", requireAuth, requireRole("DOCTOR"), async (req, res, next) => {
  try {
    const { medicines, notes } = prescriptionBodySchema.parse(req.body);
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ error: "NOT_FOUND" });
    if (appt.doctorId !== req.user.id) return res.status(403).json({ error: "FORBIDDEN" });
    if (appt.status !== "COMPLETED") return res.status(409).json({ error: "PRESCRIBE_AFTER_COMPLETION_REQUIRED" });

    appt.prescription = { medicines, notes: notes || "" };
    await appt.save();

    const users = await lookupUsers([appt.doctorId, appt.patientId]);
    const doctorEmail = users.get(appt.doctorId)?.email || "doctor";

    await notify({
      userId: appt.patientId,
      type: "PRESCRIPTION_ADDED",
      message: `A prescription was added/updated for your appointment with ${doctorEmail} on ${toISOString(appt.startTime)}.`
    });

    await upsertMedicineReminder({ userId: appt.patientId, appointmentId: appt._id.toString(), medicines: appt.prescription.medicines });

    await logActivity({
      actorUserId: req.user.id,
      action: "PRESCRIPTION_UPSERTED",
      details: { appointmentId: appt._id.toString() }
    });
    
    try {
      await axios.post(
        `${env.API_GATEWAY_URL}/api/internal/emit`,
        { event: "appointment_updated", payload: { patientId: appt.patientId, doctorId: appt.doctorId } },
        { headers: { "x-internal-api-key": env.INTERNAL_API_KEY }, timeout: 3000 }
      );
    } catch (e) {
      console.error(e.message);
    }

    return res.json({ appointment: appt });
  } catch (err) {
    return next(err);
  }
});

const notesSchema = z.object({
  consultationNotes: z.string().optional().default("")
});

router.patch("/appointments/:id/consultation-notes", requireAuth, requireRole("DOCTOR"), async (req, res, next) => {
  try {
    const { consultationNotes } = notesSchema.parse(req.body);
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ error: "NOT_FOUND" });
    if (appt.doctorId !== req.user.id) return res.status(403).json({ error: "FORBIDDEN" });
    if (!["PENDING", "ACCEPTED", "COMPLETED"].includes(appt.status)) return res.status(409).json({ error: "INVALID_STATUS_TRANSITION" });

    appt.consultationNotes = consultationNotes;
    await appt.save();

    await logActivity({
      actorUserId: req.user.id,
      action: "CONSULTATION_NOTES_UPDATED",
      details: { appointmentId: appt._id.toString() }
    });
    
    try {
      await axios.post(
        `${env.API_GATEWAY_URL}/api/internal/emit`,
        { event: "appointment_updated", payload: { patientId: appt.patientId, doctorId: appt.doctorId } },
        { headers: { "x-internal-api-key": env.INTERNAL_API_KEY }, timeout: 3000 }
      );
    } catch (e) {
      console.error(e.message);
    }

    return res.json({ appointment: appt });
  } catch (err) {
    return next(err);
  }
});

const consultationSchema = z.object({
  consultationNotes: z.string().optional().default(""),
  notes: z.string().optional(),
  followUpRecommended: z.boolean().optional().default(false),
  followUpDate: z.string().datetime().optional()
});

router.post("/appointments/:id/consultation", requireAuth, requireRole("DOCTOR"), async (req, res, next) => {
  try {
    const parsed = consultationSchema.parse(req.body);
    const { followUpRecommended, followUpDate } = parsed;
    const consultationNotes = parsed.consultationNotes || parsed.notes || "";

    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ error: "NOT_FOUND" });
    if (appt.doctorId !== req.user.id) return res.status(403).json({ error: "FORBIDDEN" });
    if (appt.status === "COMPLETED") return res.status(409).json({ error: "Consultation already completed for this appointment" });
    if (appt.status !== "ACCEPTED") return res.status(409).json({ error: "INVALID_STATUS_TRANSITION" });

    // Must not complete early
    if (Date.now() < new Date(appt.startTime).getTime()) {
      return res.status(409).json({ error: "TOO_EARLY_TO_COMPLETE" });
    }
    // Prescribing happens after completion (separate endpoint)
    if (req.body?.medicines !== undefined || req.body?.prescriptionNotes !== undefined) {
      return res.status(400).json({ error: "PRESCRIBE_AFTER_COMPLETION_REQUIRED" });
    }
    if (!consultationNotes.trim()) return res.status(400).json({ error: "CONSULTATION_NOTES_REQUIRED" });
    appt.consultationNotes = consultationNotes.trim();

    appt.status = "COMPLETED";
    if (followUpRecommended && followUpDate) {
      appt.followUpDate = new Date(followUpDate);
    } else {
      appt.followUpDate = undefined;
    }
    await appt.save();

    const users = await lookupUsers([appt.doctorId, appt.patientId]);
    const doctorEmail = users.get(appt.doctorId)?.email || "doctor";

    await notify({
      userId: appt.patientId,
      type: "APPOINTMENT_UPDATE",
      message: `Your appointment with ${doctorEmail} on ${toISOString(appt.startTime)} was marked COMPLETED.`
    });

    if (appt.followUpDate) {
      await upsertFollowUpReminder({ userId: appt.patientId, appointmentId: appt._id.toString(), dueAt: appt.followUpDate.toISOString() });
      await notify({
        userId: appt.patientId,
        type: "FOLLOW_UP_REMINDER",
        message: `Follow-up recommended on ${toISOString(appt.followUpDate)}.`
      });
    }

    await logActivity({
      actorUserId: req.user.id,
      action: "CONSULTATION_COMPLETED",
      details: { appointmentId: appt._id.toString(), followUpDate: appt.followUpDate }
    });
    
    try {
      await axios.post(
        `${env.API_GATEWAY_URL}/api/internal/emit`,
        { event: "appointment_updated", payload: { patientId: appt.patientId, doctorId: appt.doctorId } },
        { headers: { "x-internal-api-key": env.INTERNAL_API_KEY }, timeout: 3000 }
      );
    } catch (e) {
      console.error(e.message);
    }

    return res.json({ appointment: appt });
  } catch (err) {
    return next(err);
  }
});

router.get("/appointments/:id", requireAuth, async (req, res, next) => {
  try {
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ error: "NOT_FOUND" });
    const isParticipant = appt.patientId === req.user.id || appt.doctorId === req.user.id || req.user.role === "ADMIN";
    if (!isParticipant) return res.status(403).json({ error: "FORBIDDEN" });
    return res.json({ appointment: appt });
  } catch (err) {
    return next(err);
  }
});

module.exports = { appointmentRoutes: router };
