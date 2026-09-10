// Lógica compartida para crear mensajes/deliveries a partir de una plantilla,
// usada tanto por el envío masivo de siempre (routes/messages.js, POST
// /messages/:id/send) como por los puntos nuevos de la migración 010 que
// crean UN delivery para UN participante a la vez: instanciar un guion de
// chat (lib/chat.js) y seguir una rama del árbol de respuestas (routes/
// tracking.js, POST /:token/d/:deliveryId/branch). Antes esto vivía
// duplicado dentro de messages.js; sacarlo de ahí evita que las dos rutas
// de creación de un delivery (masiva vs. una a una) diverjan con el tiempo.
import { query } from "../db.js";
import { hash32, mulberry32 } from "./rng.js";

export const KINDS = ["email", "task", "chat"]; // 'chat' — migración 010
export const LANDINGS = ["form", "permiso"];

// Sorteo determinista y reproducible de si ESTE envío concreto muestra la
// intervención jolting — ver migración 006 para el porqué completo.
export function rollJolting(campaignSeed, messageId, participantCampaignId, probability) {
  const rand = mulberry32(hash32(`${campaignSeed}:${messageId}:${participantCampaignId}:jolting`));
  return rand() < Number(probability);
}

// Campos de un mensaje, resueltos desde una plantilla o desde el body directo
// (mismo contrato que antes en messages.js). `extra` permite fijar
// parent_message_id/branch_action_key (rama de respuesta) sin ensuciar la
// firma para el caso común.
export async function resolveMessageFields(body, extra = {}) {
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
        jolting_enabled: body.jolting_enabled === false ? false : true,
        parent_message_id: extra.parent_message_id ?? null,
        branch_action_key: extra.branch_action_key ?? null,
      },
    };
  }
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
      parent_message_id: extra.parent_message_id ?? null,
      branch_action_key: extra.branch_action_key ?? null,
    },
  };
}

export async function insertMessage(campaignId, f) {
  const r = await query(
    `INSERT INTO messages
       (campaign_id, template_id, kind, is_attack, vector, sender_label, subject, body, cta_label,
        landing_kind, landing_config, jolting_enabled, parent_message_id, branch_action_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14) RETURNING *`,
    [
      campaignId, f.template_id, f.kind, f.is_attack, f.vector, f.sender_label, f.subject, f.body,
      f.cta_label, f.landing_kind, JSON.stringify(f.landing_config), f.jolting_enabled,
      f.parent_message_id ?? null, f.branch_action_key ?? null,
    ]
  );
  return r.rows[0];
}

// Crea (si no existe ya) el delivery de `message` para UN participant_campaign
// y su evento 'entregado'. Idempotente por (message_id, participant_campaign_id)
// — igual que el envío masivo. Devuelve la fila de deliveries o null si ya
// existía.
export async function createDeliveryForParticipant({ message, campaignSeed, participantCampaignId }) {
  const roll = rollJolting(campaignSeed, message.id, participantCampaignId, message.jolting_probability ?? 1);
  const d = await query(
    `INSERT INTO deliveries (message_id, participant_campaign_id, jolting_roll)
     VALUES ($1, $2, $3) ON CONFLICT (message_id, participant_campaign_id) DO NOTHING
     RETURNING *`,
    [message.id, participantCampaignId, roll]
  );
  if (d.rows[0]) {
    await query(
      `INSERT INTO events (participant_campaign_id, delivery_id, event_type) VALUES ($1, $2, 'entregado')`,
      [participantCampaignId, d.rows[0].id]
    );
  }
  return d.rows[0] ?? null;
}
