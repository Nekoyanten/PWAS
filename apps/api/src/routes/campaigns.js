import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { generateAccessToken } from "../lib/tokens.js";

export const campaignsRouter = Router();

campaignsRouter.post("/", requireAdmin, async (req, res) => {
  const { name, template_id, scheduled_at } = req.body ?? {};
  if (!name || !template_id) {
    return res.status(400).json({ error: "Campos requeridos: name, template_id" });
  }
  const result = await query(
    `INSERT INTO campaigns (name, template_id, scheduled_at, status)
     VALUES ($1, $2, $3, 'borrador') RETURNING *`,
    [name, template_id, scheduled_at ?? null]
  );
  res.status(201).json({ campaign: result.rows[0] });
});

campaignsRouter.get("/", requireAdmin, async (req, res) => {
  const result = await query(
    `SELECT c.*, t.name AS template_name, t.vector
     FROM campaigns c JOIN templates t ON t.id = c.template_id
     ORDER BY c.created_at DESC`
  );
  res.json({ campaigns: result.rows });
});

// Genera un token de acceso de un solo uso por participante para esta campaña.
// participant_ids opcional: si se omite, se incluye a TODOS los participantes
// con consent_given = true que aún no tienen token para esta campaña.
campaignsRouter.post("/:id/generate-tokens", requireAdmin, async (req, res) => {
  const campaignId = req.params.id;
  const { participant_ids } = req.body ?? {};

  const campaign = await query(`SELECT id FROM campaigns WHERE id = $1`, [campaignId]);
  if (campaign.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });

  let participants;
  if (Array.isArray(participant_ids) && participant_ids.length > 0) {
    const result = await query(
      `SELECT id FROM participants WHERE id = ANY($1::uuid[]) AND consent_given = true`,
      [participant_ids]
    );
    participants = result.rows;
  } else {
    const result = await query(
      `SELECT p.id FROM participants p
       WHERE p.consent_given = true
         AND NOT EXISTS (
           SELECT 1 FROM participant_campaign pc WHERE pc.participant_id = p.id AND pc.campaign_id = $1
         )`,
      [campaignId]
    );
    participants = result.rows;
  }

  const created = [];
  for (const p of participants) {
    const token = generateAccessToken();
    const result = await query(
      `INSERT INTO participant_campaign (participant_id, campaign_id, access_token, delivered_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (participant_id, campaign_id) DO NOTHING
       RETURNING id, participant_id, access_token`,
      [p.id, campaignId, token]
    );
    if (result.rows[0]) {
      created.push(result.rows[0]);
      await query(
        `INSERT INTO events (participant_campaign_id, event_type) VALUES ($1, 'entregado')`,
        [result.rows[0].id]
      );
    }
  }

  res.status(201).json({ generated: created.length, links: created.map((c) => ({ participant_id: c.participant_id, url: `/t/${c.access_token}` })) });
});

campaignsRouter.patch("/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body ?? {};
  const valid = ["borrador", "programada", "en_curso", "finalizada", "cancelada"];
  if (!valid.includes(status)) return res.status(400).json({ error: `status inválido, debe ser uno de ${valid.join("|")}` });
  const result = await query(`UPDATE campaigns SET status = $1 WHERE id = $2 RETURNING *`, [status, req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  res.json({ campaign: result.rows[0] });
});
