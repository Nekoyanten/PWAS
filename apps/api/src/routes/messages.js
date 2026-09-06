import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { hash32, mulberry32 } from "../lib/rng.js";

export const messagesRouter = Router();

// Sorteo determinista y reproducible (mismo patrón que assignBalanced en
// lib/rng.js) de si ESTE envío concreto muestra la intervención jolting.
// Sembrado con seed de campaña + id del mensaje + id del participant_campaign
// -> siempre el mismo resultado para el mismo trío, sin importar cuántas
// veces se recalcule (auditable), y NO se vuelve a tirar en cada clic del
// participante (eso vive en deliveries.jolting_roll, fijado una sola vez
// aquí, al crear el delivery). Ver migración 006 para el porqué completo.
function rollJolting(campaignSeed, messageId, participantCampaignId, probability) {
  const rand = mulberry32(hash32(`${campaignSeed}:${messageId}:${participantCampaignId}:jolting`));
  return rand() < Number(probability);
}

const KINDS = ["email", "task"];
const LANDINGS = ["form", "permiso"];

// Campos de un mensaje, resueltos desde una plantilla o desde el body directo.
async function resolveMessageFields(body) {
  if (body.template_id) {
    const r = await query(`SELECT * FROM templates WHERE id = $1`, [body.template_id]);
    if (r.rows.length === 0) return { error: "Plantilla no encontrada" };
    const t = r.rows[0];
    return {
      fields: {
        template_id: t.id,
        kind: body.kind && KINDS.includes(body.kind) ? body.kind : t.kind,
        is_attack: t.is_attack,
        vector: t.is_attack ? t.vector : null,
        sender_label: body.sender_label ?? t.sender_label,
        subject: body.subject ?? t.subject_or_headline,
        body: body.body ?? t.message_body,
        cta_label: t.is_attack ? (body.cta_label ?? t.cta_label) : null,
        landing_kind: t.is_attack ? t.landing_kind : null,
        landing_config: t.is_attack ? t.landing_config : {},
        // Por defecto TRUE (compatibilidad hacia atrás, migración 006): el
        // admin lo desactiva explícitamente si quiere un ataque "silencioso"
        // que nunca muestre el aviso, sin importar el grupo o la probabilidad
        // de la campaña.
        jolting_enabled: body.jolting_enabled === false ? false : true,
      },
    };
  }
  // mensaje libre
  if (!body.subject) return { error: "Falta 'subject' (o 'template_id')" };
  const isAttack = !!body.is_attack;
  if (isAttack && !LANDINGS.includes(body.landing_kind)) {
    return { error: `Un mensaje de ataque necesita landing_kind (${LANDINGS.join("|")})` };
  }
  return {
    fields: {
      template_id: null,
      kind: KINDS.includes(body.kind) ? body.kind : "email",
      is_attack: isAttack,
      vector: isAttack ? (body.vector ?? null) : null,
      sender_label: body.sender_label ?? null,
      subject: body.subject,
      body: body.body ?? null,
      cta_label: isAttack ? (body.cta_label ?? "Abrir") : null,
      landing_kind: isAttack ? body.landing_kind : null,
      landing_config: isAttack ? (body.landing_config ?? {}) : {},
      jolting_enabled: body.jolting_enabled === false ? false : true,
    },
  };
}

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
    const roll = rollJolting(msg.campaign_seed, msg.id, row.id, msg.jolting_probability);
    const d = await query(
      `INSERT INTO deliveries (message_id, participant_campaign_id, jolting_roll)
       VALUES ($1, $2, $3) ON CONFLICT (message_id, participant_campaign_id) DO NOTHING
       RETURNING id`,
      [msg.id, row.id, roll]
    );
    if (d.rows[0]) {
      delivered++;
      await query(
        `INSERT INTO events (participant_campaign_id, delivery_id, event_type) VALUES ($1, $2, 'entregado')`,
        [row.id, d.rows[0].id]
      );
    }
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
