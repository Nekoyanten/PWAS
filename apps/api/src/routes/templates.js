import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

export const templatesRouter = Router();

const VALID_VECTORS = ["autoridad", "urgencia", "escasez", "prueba_social", "curiosidad"];
const VALID_CHANNELS = ["email_simulado", "sms_simulado", "web"];

templatesRouter.post("/", requireAdmin, async (req, res) => {
  const { name, vector, channel, subject_or_headline, body_ref } = req.body ?? {};
  if (!name || !VALID_VECTORS.includes(vector) || !VALID_CHANNELS.includes(channel) || !subject_or_headline || !body_ref) {
    return res.status(400).json({
      error: "Campos requeridos: name, vector (uno de " + VALID_VECTORS.join("|") + "), channel (uno de " + VALID_CHANNELS.join("|") + "), subject_or_headline, body_ref",
    });
  }
  const result = await query(
    `INSERT INTO templates (name, vector, channel, subject_or_headline, body_ref)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, vector, channel, subject_or_headline, body_ref]
  );
  res.status(201).json({ template: result.rows[0] });
});

templatesRouter.get("/", requireAdmin, async (req, res) => {
  const result = await query(`SELECT * FROM templates ORDER BY created_at DESC`);
  res.json({ templates: result.rows });
});
