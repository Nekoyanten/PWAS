import { Router } from "express";
import { query } from "../db.js";
import { buildSurveySchema, debriefText } from "../lib/survey.js";
import {
  renderWelcome, renderApp, renderMessage, renderStimulusLanding,
  renderActionDone, renderSurvey, renderDebrief, renderInvalid,
} from "../lib/decoy.js";

export const trackingRouter = Router();

// Rutas PÚBLICAS del participante (solo token, sin x-api-key). Ningún endpoint
// persiste contenido escrito por el participante. Ver nota en schema.sql.

const HTML = { "Content-Type": "text/html; charset=utf-8" };

async function loadPC(token) {
  const r = await query(
    `SELECT pc.id, pc.participant_id, pc.campaign_id, pc.access_token,
            pc.session_started_at, pc.finished_at,
            p.consent_given,
            c.name AS campaign_name, c.status AS campaign_status
     FROM participant_campaign pc
     JOIN participants p ON p.id = pc.participant_id
     JOIN campaigns c ON c.id = pc.campaign_id
     WHERE pc.access_token = $1`,
    [token]
  );
  return r.rows[0] ?? null;
}

async function loadDelivery(pcId, deliveryId) {
  const r = await query(
    `SELECT d.id AS delivery_id, d.delivered_at,
            m.id AS message_id, m.kind, m.is_attack, m.vector, m.sender_label,
            m.subject, m.body, m.cta_label, m.landing_kind, m.landing_config
     FROM deliveries d JOIN messages m ON m.id = d.message_id
     WHERE d.id = $1 AND d.participant_campaign_id = $2`,
    [deliveryId, pcId]
  );
  return r.rows[0] ?? null;
}

function reactionMs(deliveredAt) {
  return deliveredAt ? Date.now() - new Date(deliveredAt).getTime() : null;
}

// Dedup por (delivery, tipo): reabrir el mismo mensaje no cuenta dos veces,
// pero un envío nuevo (otro delivery) sí se mide aparte.
async function recordOnce(pcId, deliveryId, type, reaction = null, detail = null) {
  const ex = await query(
    `SELECT id FROM events WHERE delivery_id = $1 AND event_type = $2`,
    [deliveryId, type]
  );
  if (ex.rows.length > 0) return ex.rows[0];
  const r = await query(
    `INSERT INTO events (participant_campaign_id, delivery_id, event_type, reaction_time_ms, detail)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [pcId, deliveryId, type, reaction, detail]
  );
  return r.rows[0];
}

async function buildInbox(pcId) {
  const r = await query(
    `SELECT d.id AS delivery_id, m.kind, m.is_attack, m.sender_label, m.subject, m.body, m.cta_label,
            EXISTS (SELECT 1 FROM events e WHERE e.delivery_id = d.id AND e.event_type = 'abierto') AS opened
     FROM deliveries d JOIN messages m ON m.id = d.message_id
     WHERE d.participant_campaign_id = $1
     ORDER BY d.delivered_at DESC`,
    [pcId]
  );
  return r.rows.map((x) => ({
    deliveryId: x.delivery_id,
    kind: x.kind,
    is_attack: x.is_attack,
    from: x.sender_label || (x.kind === "task" ? "TaskFlow" : "Notificaciones"),
    subject: x.subject,
    body: x.body,
    cta_label: x.cta_label,
    unread: x.is_attack && !x.opened,
  }));
}

// Determina el "ataque principal" del participante para la encuesta/debrief:
// aquel con el que interactuó; si no, el último recibido.
async function primaryAttack(pcId) {
  const r = await query(
    `SELECT d.id AS delivery_id, m.id AS message_id, m.vector,
       (SELECT COUNT(*) FROM events e WHERE e.delivery_id = d.id AND e.event_type IN ('clic','intento_envio','permiso_concedido')) AS engaged,
       (SELECT COUNT(*) FROM events e WHERE e.delivery_id = d.id AND e.event_type = 'abierto') AS opened
     FROM deliveries d JOIN messages m ON m.id = d.message_id
     WHERE d.participant_campaign_id = $1 AND m.is_attack = TRUE
     ORDER BY engaged DESC, opened DESC, d.delivered_at DESC
     LIMIT 1`,
    [pcId]
  );
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
trackingRouter.get("/:token", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  const t = encodeURIComponent(pc.access_token);
  if (!pc.consent_given) return res.set(HTML).send(renderWelcome(pc.access_token, pc.campaign_name));
  if (pc.finished_at || pc.campaign_status === "finalizada") return res.redirect(`/t/${t}/survey`);
  return res.redirect(`/t/${t}/app`);
});

trackingRouter.post("/:token/consent", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  const ok = req.body && (req.body.consent === "1" || req.body.consent === 1 || req.body.consent === true);
  if (!ok) return res.set(HTML).send(renderWelcome(pc.access_token, pc.campaign_name));
  if (!pc.consent_given) {
    await query(`UPDATE participants SET consent_given = TRUE, consent_timestamp = now() WHERE id = $1 AND consent_given = FALSE`, [pc.participant_id]);
  }
  res.redirect(`/t/${encodeURIComponent(pc.access_token)}/app`);
});

trackingRouter.get("/:token/app", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  if (!pc.consent_given) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}`);
  if (!pc.session_started_at) {
    await query(`UPDATE participant_campaign SET session_started_at = now() WHERE id = $1 AND session_started_at IS NULL`, [pc.id]);
  }
  const inbox = await buildInbox(pc.id);
  res.set(HTML).send(renderApp(pc.access_token, { inbox }));
});

// Ver un mensaje entregado. Abrir uno de ataque = evento 'abierto'.
trackingRouter.get("/:token/d/:deliveryId", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  if (!pc.consent_given) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}`);
  const d = await loadDelivery(pc.id, req.params.deliveryId);
  if (!d) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}/app`);
  if (d.is_attack) await recordOnce(pc.id, d.delivery_id, "abierto", reactionMs(d.delivered_at));
  res.set(HTML).send(renderMessage(pc.access_token, {
    deliveryId: d.delivery_id, kind: d.kind, is_attack: d.is_attack,
    from: d.sender_label || (d.kind === "task" ? "TaskFlow" : "Notificaciones"),
    subject: d.subject, body: d.body, cta_label: d.cta_label,
  }));
});

// CTA del estímulo -> 'clic' + aterrizaje.
trackingRouter.get("/:token/d/:deliveryId/go", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  const d = await loadDelivery(pc.id, req.params.deliveryId);
  if (!pc.consent_given || !d || !d.is_attack) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}/app`);
  await recordOnce(pc.id, d.delivery_id, "abierto", reactionMs(d.delivered_at));
  await recordOnce(pc.id, d.delivery_id, "clic", reactionMs(d.delivered_at));
  res.set(HTML).send(renderStimulusLanding(pc.access_token, {
    deliveryId: d.delivery_id, landing_kind: d.landing_kind || "form", landing_config: d.landing_config || {},
  }));
});

trackingRouter.post("/:token/d/:deliveryId/submit", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).json({ error: "Enlace no válido." });
  const d = await loadDelivery(pc.id, req.params.deliveryId);
  if (!d) return res.status(404).json({ error: "Mensaje no encontrado." });
  await recordOnce(pc.id, d.delivery_id, "intento_envio", reactionMs(d.delivered_at));
  if (req.is("application/json") || (req.headers.accept || "").includes("application/json")) {
    return res.json({ ok: true, message: "Registrado. Ningún dato ingresado fue almacenado." });
  }
  res.redirect(`/t/${encodeURIComponent(pc.access_token)}/action-done`);
});

trackingRouter.post("/:token/d/:deliveryId/authorize", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).json({ error: "Enlace no válido." });
  const d = await loadDelivery(pc.id, req.params.deliveryId);
  if (!d) return res.status(404).json({ error: "Mensaje no encontrado." });
  const scope = String((req.body && (req.body.scope || req.body.permiso)) || "desconocido").slice(0, 40).replace(/[^a-z_]/gi, "") || "desconocido";
  await recordOnce(pc.id, d.delivery_id, "permiso_concedido", reactionMs(d.delivered_at), scope);
  res.redirect(`/t/${encodeURIComponent(pc.access_token)}/action-done`);
});

trackingRouter.post("/:token/d/:deliveryId/report", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).json({ error: "Enlace no válido." });
  const d = await loadDelivery(pc.id, req.params.deliveryId);
  if (!d) return res.status(404).json({ error: "Mensaje no encontrado." });
  await recordOnce(pc.id, d.delivery_id, "reportado", reactionMs(d.delivered_at));
  res.json({ ok: true });
});

trackingRouter.get("/:token/action-done", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  res.set(HTML).send(renderActionDone(pc.access_token));
});

trackingRouter.post("/:token/usability", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(204).end();
  await query(`UPDATE participant_campaign SET usability_interactions = LEAST(usability_interactions + 1, 100000) WHERE id = $1`, [pc.id]);
  res.status(204).end();
});

trackingRouter.post("/:token/finish", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  if (!pc.finished_at) await query(`UPDATE participant_campaign SET finished_at = now() WHERE id = $1 AND finished_at IS NULL`, [pc.id]);
  res.redirect(`/t/${encodeURIComponent(pc.access_token)}/survey`);
});

// ---------------------------------------------------------------------------
trackingRouter.get("/:token/survey", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  const t = encodeURIComponent(pc.access_token);
  if (!pc.consent_given) return res.redirect(`/t/${t}`);
  if (!pc.finished_at && pc.campaign_status !== "finalizada") return res.redirect(`/t/${t}/app`);
  const already = await query(`SELECT 1 FROM post_session_survey WHERE participant_campaign_id = $1`, [pc.id]);
  if (already.rows.length > 0) return res.redirect(`/t/${t}/debrief`);
  const attack = await primaryAttack(pc.id);
  res.set(HTML).send(renderSurvey(pc.access_token, buildSurveySchema(attack ? attack.vector : null)));
});

trackingRouter.post("/:token/survey", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).json({ error: "Enlace no válido." });
  const body = req.body ?? {};
  const toBool = (v) => (v === "true" || v === true ? true : v === "false" || v === false ? false : null);

  const attack = await primaryAttack(pc.id);
  const fellRes = await query(
    `SELECT EXISTS (
       SELECT 1 FROM events e JOIN deliveries d ON d.id = e.delivery_id JOIN messages m ON m.id = d.message_id
       WHERE d.participant_campaign_id = $1 AND m.is_attack = TRUE
         AND e.event_type IN ('clic','intento_envio','permiso_concedido')
     ) AS fell`,
    [pc.id]
  );
  const fell = fellRes.rows[0].fell;

  const validReasons = ["miedo_sancion", "promesa_beneficio", "confianza_remitente", "urgencia_temporal", "prueba_social", "curiosidad", "no_aplica"];
  const fallReason = validReasons.includes(body.fall_reason) ? body.fall_reason : "no_aplica";

  await query(
    `INSERT INTO post_session_survey
       (participant_campaign_id, primary_message_id, fell_for_attack, fall_reason,
        perceived_suspicion_before_action, recognized_as_simulated, vector_specific_answer, free_comment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (participant_campaign_id) DO UPDATE SET
       primary_message_id = EXCLUDED.primary_message_id,
       fell_for_attack = EXCLUDED.fell_for_attack,
       fall_reason = EXCLUDED.fall_reason,
       perceived_suspicion_before_action = EXCLUDED.perceived_suspicion_before_action,
       recognized_as_simulated = EXCLUDED.recognized_as_simulated,
       vector_specific_answer = EXCLUDED.vector_specific_answer,
       free_comment = EXCLUDED.free_comment`,
    [
      pc.id, attack ? attack.message_id : null, fell, fallReason,
      toBool(body.perceived_suspicion_before_action),
      toBool(body.recognized_as_simulated),
      typeof body.vector_specific_answer === "string" ? body.vector_specific_answer.slice(0, 200) : null,
      typeof body.free_comment === "string" ? body.free_comment.slice(0, 1000) : null,
    ]
  );
  res.redirect(`/t/${encodeURIComponent(pc.access_token)}/debrief`);
});

trackingRouter.get("/:token/debrief", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  const attack = await primaryAttack(pc.id);
  res.set(HTML).send(renderDebrief(debriefText(attack ? attack.vector : null)));
});
