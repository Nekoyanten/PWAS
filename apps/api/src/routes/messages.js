import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { resolveMessageFields, createDeliveryForParticipant } from "../lib/messageFactory.js";

export const messagesRouter = Router();

// rollJolting/resolveMessageFields ahora viven en lib/messageFactory.js —
// migración 010 los comparte con la instanciación de guiones de chat y con
// el árbol de respuestas (routes/tracking.js), que también necesitan crear
// un delivery a partir de una plantilla para UN participante a la vez.

messagesRouter.get("/campaigns/:id/messages", requireAdmin, async (req, res) => {
  const r = await query(
    `SELECT m.*,
       (SELECT COUNT(*) FROM deliveries d WHERE d.message_id = m.id) AS enviados,
       (SELECT COUNT(DISTINCT e.delivery_id) FROM events e JOIN deliveries d ON d.id = e.delivery_id
          WHERE d.message_id = m.id AND e.event_type = 'abierto') AS abiertos,
       (SELECT COUNT(DISTINCT e.delivery_id) FROM events e JOIN deliveries d ON d.id = e.delivery_id
          WHERE d.message_id = m.id AND e.event_type = 'clic') AS clics,
       (SELECT COUNT(DISTINCT e.delivery_id) FROM events e JOIN deliveries d ON d.id = e.delivery_id
          WHERE d.message_id = m.id AND e.event_type IN ('intento_envio','permiso_concedido')) AS conversiones,
       (SELECT COUNT(DISTINCT e.delivery_id) FROM events e JOIN deliveries d ON d.id = e.delivery_id
          WHERE d.message_id = m.id AND e.event_type = 'reportado') AS reportes
     FROM messages m WHERE m.campaign_id = $1 ORDER BY m.created_at DESC`,
    [req.params.id]
  );
  res.json({ messages: r.rows });
});

messagesRouter.post("/campaigns/:id/messages", requireAdmin, async (req, res) => {
  const c = await query(`SELECT id FROM campaigns WHERE id = $1`, [req.params.id]);
  if (c.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });

  const resolved = await resolveMessageFields(req.body ?? {});
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const f = resolved.fields;

  const r = await query(
    `INSERT INTO messages
       (campaign_id, template_id, kind, is_attack, vector, sender_label, subject, body, cta_label, landing_kind, landing_config, jolting_enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) RETURNING *`,
    [req.params.id, f.template_id, f.kind, f.is_attack, f.vector, f.sender_label, f.subject, f.body, f.cta_label, f.landing_kind, JSON.stringify(f.landing_config), f.jolting_enabled]
  );
  res.status(201).json({ message: r.rows[0] });
});

// Envía el mensaje a los participantes de los equipos indicados (o a todos
// los de la campaña si all=true). Cada envío nuevo = un delivery nuevo =
// medición independiente. Reenviar a alguien que ya lo recibió no duplica;
// para re-medir, clona el mensaje.
messagesRouter.post("/messages/:id/send", requireAdmin, async (req, res) => {
  // Se trae seed y jolting_probability de la campaña en la misma consulta:
  // el sorteo de jolting (más abajo) necesita ambos y se calcula una vez por
  // delivery, en este endpoint, no en cada clic (ver migración 006).
  const m = await query(
    `SELECT msg.*, c.seed AS campaign_seed, c.jolting_probability
     FROM messages msg JOIN campaigns c ON c.id = msg.campaign_id
     WHERE msg.id = $1`,
    [req.params.id]
  );
  if (m.rows.length === 0) return res.status(404).json({ error: "Mensaje no encontrado" });
  const msg = m.rows[0];

  const { team_labels, all } = req.body ?? {};
  const useAll = all === true || all === "true";
  if (!useAll && (!Array.isArray(team_labels) || team_labels.length === 0)) {
    return res.status(400).json({ error: "Indica team_labels: [...] o all: true" });
  }

  const targets = await query(
    `SELECT pc.id
     FROM participant_campaign pc
     JOIN participants p ON p.id = pc.participant_id
     WHERE pc.campaign_id = $1
       ${useAll ? "" : "AND p.team_label = ANY($2::text[])"}`,
    useAll ? [msg.campaign_id] : [msg.campaign_id, team_labels]
  );

  let delivered = 0;
  for (const row of targets.rows) {
    const d = await createDeliveryForParticipant({
      message: { id: msg.id, jolting_probability: msg.jolting_probability },
      campaignSeed: msg.campaign_seed,
      participantCampaignId: row.id,
    });
    if (d) delivered++;
  }
  await query(`UPDATE campaigns SET status = 'en_curso' WHERE id = $1 AND status IN ('borrador','programada')`, [msg.campaign_id]);
  res.json({ delivered, targets: targets.rows.length, skipped: targets.rows.length - delivered });
});

// Clona el mensaje (mismo contenido, campaña) para poder reenviarlo como una
// medición nueva.
messagesRouter.post("/messages/:id/clone", requireAdmin, async (req, res) => {
  const m = await query(`SELECT * FROM messages WHERE id = $1`, [req.params.id]);
  if (m.rows.length === 0) return res.status(404).json({ error: "Mensaje no encontrado" });
  const s = m.rows[0];
  const r = await query(
    `INSERT INTO messages
       (campaign_id, template_id, kind, is_attack, vector, sender_label, subject, body, cta_label, landing_kind, landing_config, jolting_enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [s.campaign_id, s.template_id, s.kind, s.is_attack, s.vector, s.sender_label, `${s.subject} (reenvío)`, s.body, s.cta_label, s.landing_kind, s.landing_config, s.jolting_enabled]
  );
  res.status(201).json({ message: r.rows[0] });
});

messagesRouter.delete("/messages/:id", requireAdmin, async (req, res) => {
  const r = await query(`DELETE FROM messages WHERE id = $1 RETURNING id`, [req.params.id]);
  if (r.rows.length === 0) return res.status(404).json({ error: "Mensaje no encontrado" });
  res.json({ deleted: r.rows[0].id });
});
