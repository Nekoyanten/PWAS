import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { generateAccessToken } from "../lib/tokens.js";
import { assignBalanced } from "../lib/rng.js";

export const campaignsRouter = Router();

const VALID_STATUS = ["borrador", "programada", "en_curso", "finalizada", "cancelada"];

// Devuelve los ids de plantilla que entran en el sorteo de una campaña:
// las de campaign_templates, o [template_id] como fallback.
async function poolTemplateIds(campaignId, fallbackTemplateId) {
  const r = await query(`SELECT template_id FROM campaign_templates WHERE campaign_id = $1`, [campaignId]);
  if (r.rows.length > 0) return r.rows.map((x) => x.template_id);
  return fallbackTemplateId ? [fallbackTemplateId] : [];
}

campaignsRouter.post("/", requireAdmin, async (req, res) => {
  const { name, template_id, template_ids, seed, scheduled_at } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "Campo requerido: name" });

  const pool = Array.isArray(template_ids) ? template_ids.filter(Boolean) : [];
  const defaultTpl = template_id ?? pool[0] ?? null;

  const result = await query(
    `INSERT INTO campaigns (name, template_id, seed, scheduled_at, status)
     VALUES ($1, $2, COALESCE($3, substr(md5(random()::text),1,12)), $4, 'borrador')
     RETURNING *`,
    [name, defaultTpl, seed ?? null, scheduled_at ?? null]
  );
  const campaign = result.rows[0];

  for (const tid of pool) {
    await query(
      `INSERT INTO campaign_templates (campaign_id, template_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [campaign.id, tid]
    );
  }
  res.status(201).json({ campaign });
});

campaignsRouter.get("/", requireAdmin, async (req, res) => {
  const result = await query(
    `SELECT c.*, t.name AS template_name, t.vector,
            (SELECT COUNT(*) FROM campaign_templates ct WHERE ct.campaign_id = c.id) AS pool_size,
            (SELECT COUNT(*) FROM participant_campaign pc WHERE pc.campaign_id = c.id) AS links,
            (SELECT COUNT(*) FROM participant_campaign pc WHERE pc.campaign_id = c.id AND pc.delivered_at IS NOT NULL) AS delivered
     FROM campaigns c
     LEFT JOIN templates t ON t.id = c.template_id
     ORDER BY c.created_at DESC`
  );
  res.json({ campaigns: result.rows });
});

campaignsRouter.get("/:id", requireAdmin, async (req, res) => {
  const c = await query(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
  if (c.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  const pool = await query(
    `SELECT t.* FROM campaign_templates ct JOIN templates t ON t.id = ct.template_id
     WHERE ct.campaign_id = $1 ORDER BY t.vector`,
    [req.params.id]
  );
  const dist = await query(
    `SELECT t.vector, COUNT(*) AS n
     FROM participant_campaign pc JOIN templates t ON t.id = pc.assigned_template_id
     WHERE pc.campaign_id = $1 GROUP BY t.vector ORDER BY t.vector`,
    [req.params.id]
  );
  res.json({ campaign: c.rows[0], pool: pool.rows, assignment_distribution: dist.rows });
});

campaignsRouter.put("/:id", requireAdmin, async (req, res) => {
  const { name, seed, template_id, template_ids } = req.body ?? {};
  const cur = await query(`SELECT * FROM campaigns WHERE id = $1`, [req.params.id]);
  if (cur.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });

  const updated = await query(
    `UPDATE campaigns SET name = COALESCE($1, name), seed = COALESCE($2, seed),
       template_id = COALESCE($3, template_id)
     WHERE id = $4 RETURNING *`,
    [name ?? null, seed ?? null, template_id ?? null, req.params.id]
  );

  if (Array.isArray(template_ids)) {
    await query(`DELETE FROM campaign_templates WHERE campaign_id = $1`, [req.params.id]);
    for (const tid of template_ids.filter(Boolean)) {
      await query(`INSERT INTO campaign_templates (campaign_id, template_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, tid]);
    }
  }
  res.json({ campaign: updated.rows[0] });
});

// Genera un enlace de un solo uso por participante y le ASIGNA un estímulo
// del pool de la campaña, repartido de forma balanceada y reproducible según
// campaigns.seed. NO entrega el estímulo todavía (ver POST /:id/deliver).
campaignsRouter.post("/:id/generate-tokens", requireAdmin, async (req, res) => {
  const campaignId = req.params.id;
  const { participant_ids } = req.body ?? {};

  const c = await query(`SELECT id, seed, template_id FROM campaigns WHERE id = $1`, [campaignId]);
  if (c.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  const campaign = c.rows[0];

  const pool = await poolTemplateIds(campaignId, campaign.template_id);
  if (pool.length === 0) {
    return res.status(400).json({ error: "La campaña no tiene plantillas. Añade al menos una (template_ids) o define template_id." });
  }

  let participants;
  if (Array.isArray(participant_ids) && participant_ids.length > 0) {
    const r = await query(
      `SELECT id FROM participants WHERE id = ANY($1::uuid[])
         AND NOT EXISTS (SELECT 1 FROM participant_campaign pc WHERE pc.participant_id = participants.id AND pc.campaign_id = $2)
       ORDER BY id`,
      [participant_ids, campaignId]
    );
    participants = r.rows;
  } else {
    const r = await query(
      `SELECT p.id FROM participants p
       WHERE NOT EXISTS (SELECT 1 FROM participant_campaign pc WHERE pc.participant_id = p.id AND pc.campaign_id = $1)
       ORDER BY p.id`,
      [campaignId]
    );
    participants = r.rows;
  }

  // Reparto reproducible del pool entre estos participantes.
  const assigned = assignBalanced(pool, participants.length, `${campaign.seed}:${campaignId}`);

  const created = [];
  for (let i = 0; i < participants.length; i++) {
    const token = generateAccessToken();
    const r = await query(
      `INSERT INTO participant_campaign (participant_id, campaign_id, access_token, assigned_template_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (participant_id, campaign_id) DO NOTHING
       RETURNING id, participant_id, access_token, assigned_template_id`,
      [participants[i].id, campaignId, token, assigned[i]]
    );
    if (r.rows[0]) created.push(r.rows[0]);
  }

  res.status(201).json({
    generated: created.length,
    links: created.map((x) => ({ participant_id: x.participant_id, url: `/t/${x.access_token}` })),
  });
});

// El admin ENTREGA el estímulo: fija delivered_at y registra 'entregado'.
// A partir de aquí el mensaje aparece en la bandeja del participante y el
// tiempo de reacción se mide desde este momento.
campaignsRouter.post("/:id/deliver", requireAdmin, async (req, res) => {
  const campaignId = req.params.id;
  const { participant_campaign_ids } = req.body ?? {};

  const c = await query(`SELECT id FROM campaigns WHERE id = $1`, [campaignId]);
  if (c.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });

  const filter = Array.isArray(participant_campaign_ids) && participant_campaign_ids.length > 0;
  const rows = await query(
    `UPDATE participant_campaign
       SET delivered_at = now()
     WHERE campaign_id = $1 AND delivered_at IS NULL
       ${filter ? "AND id = ANY($2::uuid[])" : ""}
     RETURNING id`,
    filter ? [campaignId, participant_campaign_ids] : [campaignId]
  );
  for (const r of rows.rows) {
    await query(`INSERT INTO events (participant_campaign_id, event_type) VALUES ($1, 'entregado')`, [r.id]);
  }
  await query(`UPDATE campaigns SET status = 'en_curso' WHERE id = $1 AND status IN ('borrador','programada')`, [campaignId]);
  res.json({ delivered: rows.rows.length });
});

campaignsRouter.patch("/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body ?? {};
  if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: `status inválido: ${VALID_STATUS.join("|")}` });
  const r = await query(`UPDATE campaigns SET status = $1 WHERE id = $2 RETURNING *`, [status, req.params.id]);
  if (r.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  res.json({ campaign: r.rows[0] });
});

// Lista de enlaces de una campaña (para entregar a los participantes / exportar).
campaignsRouter.get("/:id/links", requireAdmin, async (req, res) => {
  const r = await query(
    `SELECT pc.id, pc.access_token, pc.delivered_at, pc.session_started_at, pc.finished_at,
            p.external_hash, p.role, p.team_label,
            t.vector AS assigned_vector, t.name AS assigned_template
     FROM participant_campaign pc
     JOIN participants p ON p.id = pc.participant_id
     LEFT JOIN templates t ON t.id = pc.assigned_template_id
     WHERE pc.campaign_id = $1
     ORDER BY p.team_label, p.external_hash`,
    [req.params.id]
  );
  res.json({
    links: r.rows.map((x) => ({ ...x, url: `/t/${x.access_token}` })),
  });
});
