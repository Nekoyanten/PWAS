import { Router } from "express";
import { query } from "../db.js";
import { buildSurveySchema, debriefText } from "../lib/survey.js";
import {
  renderWelcome, renderApp, renderMessage, renderStimulusLanding,
  renderActionDone, renderSurvey, renderDebrief, renderInvalid,
  renderJoltingInterstitial,
} from "../lib/decoy.js";

export const trackingRouter = Router();

// Rutas PÚBLICAS del participante (solo token, sin x-api-key). Ningún endpoint
// persiste contenido escrito por el participante. Ver nota en schema.sql.

const HTML = { "Content-Type": "text/html; charset=utf-8" };

async function loadPC(token) {
  const r = await query(
    `SELECT pc.id, pc.participant_id, pc.campaign_id, pc.access_token,
            pc.session_started_at, pc.finished_at,
            p.consent_given, p.group_assignment,
            c.name AS campaign_name, c.status AS campaign_status
     FROM participant_campaign pc
     JOIN participants p ON p.id = pc.participant_id
     JOIN campaigns c ON c.id = pc.campaign_id
     WHERE pc.access_token = $1`,
    [token]
  );
  return r.rows[0] ?? null;
}

// TG §8.2.5 / §9.2: solo el grupo 'experimental' recibe la capa de
// intervención (jolting). 'control' y participantes sin grupo asignado (p.ej.
// datos de campañas antiguas o importados sin group_assignment) mantienen el
// flujo original, sin interstitial.
function isExperimental(pc) {
  return pc.group_assignment === "experimental";
}

// ¿Ya se le mostró la intervención a este delivery? Se muestra una sola vez
// por estímulo: un jolt repetido en cada re-visita dejaría de sorprender
// (habituación) y no es lo que describe §8.2.5.
async function interventionAlreadyShown(deliveryId) {
  const r = await query(
    `SELECT 1 FROM events WHERE delivery_id = $1 AND event_type = 'intervencion_mostrada'`,
    [deliveryId]
  );
  return r.rows.length > 0;
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
  res.set(HTML).send(renderApp(pc.access_token, { inbox, view: req.query.v }));
});

// Bandeja en JSON para el sondeo en vivo del tablero (sin recargar la página).
trackingRouter.get("/:token/inbox.json", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc || !pc.consent_given) return res.status(404).json({ error: "no" });
  if (pc.finished_at || pc.campaign_status === "finalizada") {
    return res.json({ done: true, unread: 0, items: [] });
  }
  const inbox = await buildInbox(pc.id);
  res.json({
    unread: inbox.filter((m) => m.unread).length,
    items: inbox.map((m) => ({
      deliveryId: m.deliveryId,
      kind: m.kind,
      from: m.from,
      subject: m.subject,
      preview: (m.body || "").replace(/<[^>]+>/g, "").slice(0, 90),
      unread: m.unread,
    })),
  });
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

// CTA del estímulo. Grupo control (o sin grupo): comportamiento original,
// directo al aterrizaje. Grupo experimental, primera vez sobre este delivery:
// se interpone la capa de intervención (jolting, TG §8.2.5) antes de dejar
// pasar al aterrizaje o de permitir cancelar.
trackingRouter.get("/:token/d/:deliveryId/go", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  const d = await loadDelivery(pc.id, req.params.deliveryId);
  if (!pc.consent_given || !d || !d.is_attack) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}/app`);

  if (isExperimental(pc) && !(await interventionAlreadyShown(d.delivery_id))) {
    await recordOnce(pc.id, d.delivery_id, "intervencion_mostrada", reactionMs(d.delivered_at));
    return res.set(HTML).send(renderJoltingInterstitial(pc.access_token, { deliveryId: d.delivery_id }));
  }

  await recordOnce(pc.id, d.delivery_id, "abierto", reactionMs(d.delivered_at));
  await recordOnce(pc.id, d.delivery_id, "clic", reactionMs(d.delivered_at));
  res.set(HTML).send(renderStimulusLanding(pc.access_token, {
    deliveryId: d.delivery_id, landing_kind: d.landing_kind || "form", landing_config: d.landing_config || {},
  }));
});

// El participante experimental sostiene la pausa obligatoria y decide
// continuar de todas formas -> mismo registro y aterrizaje que el control.
trackingRouter.post("/:token/d/:deliveryId/proceed", async (req, res) => {
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

// El participante experimental cancela desde la intervención -> se registra
// como reversión de la acción de riesgo (TG §8.2.5, "bloquear o revertir") y
// NUNCA se marca 'clic' ni 'abierto': para efectos de fell_for_attack, la
// intervención evitó la caída.
trackingRouter.post("/:token/d/:deliveryId/cancel", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  const d = await loadDelivery(pc.id, req.params.deliveryId);
  if (!d) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}/app`);
  await recordOnce(pc.id, d.delivery_id, "intervencion_cancelada", reactionMs(d.delivered_at));
  res.redirect(`/t/${encodeURIComponent(pc.access_token)}/app`);
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

// ---------------------------------------------------------------------------
// Captura conductual real (Tabla 1 §8.2.1, fila 1). Ver apps/api/public/js/
// behavior-capture.js para qué envía el navegador y por qué, y la migración
// 004_behavior_capture.sql para el esquema. Este endpoint solo valida y
// guarda: no calcula nada (el preprocesamiento es un workstream aparte).
//
// Deliberadamente NO usa recordOnce/dedup como el resto de este archivo: acá
// SÍ queremos cada muestra, son la señal en sí, no un evento de negocio.
const BEHAVIOR_EVENT_TYPES = new Set([
  "mousemove", "mousedown", "mouseup", "click",
  "keydown", "keyup",
  "visibility_hidden", "visibility_visible",
]);
const BEHAVIOR_MAX_SAMPLES_PER_REQUEST = 300; // debe calzar con MAX_SAMPLES_PER_REQUEST en behavior-capture.js.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Clampea a un entero dentro de [min, max], o null si no es un número válido.
// Los SMALLINT de behavior_events (x, y) truenan con un INSERT fuera de rango
// en vez de guardar un valor cualquiera; mejor perder un campo que la fila
// entera por un valor absurdo que mande el navegador (o un cliente hostil).
function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function sanitizeSample(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!BEHAVIOR_EVENT_TYPES.has(raw.type)) return null;
  const t = clampInt(raw.t, 0, 24 * 60 * 60 * 1000); // tope generoso de 24h; descarta basura sin bloquear el resto del lote.
  if (t === null) return null;
  return {
    t_ms: t,
    event_type: raw.type,
    x: raw.x === undefined ? null : clampInt(raw.x, -32768, 32767),
    y: raw.y === undefined ? null : clampInt(raw.y, -32768, 32767),
    key_code: typeof raw.code === "string" ? raw.code.slice(0, 40) : null,
  };
}

// INSERT multi-fila en una sola ida a la base — con lotes de hasta 300
// muestras por request, una fila a la vez sería 300 round-trips por flush.
const BEHAVIOR_EVENT_COLUMNS = 6; // behavior_session_id, t_ms, event_type, x, y, key_code

async function insertBehaviorEvents(sessionId, samples) {
  const values = [];
  const placeholders = samples.map((s, i) => {
    const base = i * BEHAVIOR_EVENT_COLUMNS;
    values.push(sessionId, s.t_ms, s.event_type, s.x, s.y, s.key_code);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });
  await query(
    `INSERT INTO behavior_events (behavior_session_id, t_ms, event_type, x, y, key_code)
     VALUES ${placeholders.join(", ")}`,
    values
  );
}

trackingRouter.post("/:token/behavior", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(204).end(); // mismo criterio que /usability: un token vencido no debe romper la página del participante.

  const body = req.body ?? {};
  if (!UUID_RE.test(body.session_id || "")) return res.status(400).json({ error: "session_id inválido" });
  if (typeof body.phase !== "string" || !body.phase) return res.status(400).json({ error: "phase requerido" });
  if (!Array.isArray(body.samples) || body.samples.length === 0) return res.status(400).json({ error: "samples requerido" });
  if (body.samples.length > BEHAVIOR_MAX_SAMPLES_PER_REQUEST) {
    return res.status(400).json({ error: `máximo ${BEHAVIOR_MAX_SAMPLES_PER_REQUEST} muestras por request` });
  }
  const deliveryId = typeof body.delivery_id === "string" && UUID_RE.test(body.delivery_id) ? body.delivery_id : null;

  const samples = body.samples.map(sanitizeSample).filter(Boolean);
  if (samples.length === 0) return res.status(400).json({ error: "ninguna muestra válida en el lote" });

  try {
    // La sesión la crea el NAVEGADOR (session_id viene armado desde el
    // cliente) — el servidor solo la registra la primera vez que la ve.
    // Un delivery_id que no pertenezca a este participante simplemente no
    // hace match en el JOIN de análisis después; no hace falta validarlo
    // aquí porque no se usa para autorizar nada, solo es metadata.
    await query(
      `INSERT INTO behavior_sessions (id, participant_campaign_id, delivery_id, phase, viewport_w, viewport_h, sample_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         last_flush_at = now(),
         sample_count = behavior_sessions.sample_count + EXCLUDED.sample_count`,
      [
        body.session_id, pc.id, deliveryId, body.phase.slice(0, 40),
        clampInt(body.viewport_w, 0, 32767), clampInt(body.viewport_h, 0, 32767),
        samples.length,
      ]
    );
    await insertBehaviorEvents(body.session_id, samples);
    res.status(204).end();
  } catch (err) {
    // Un session_id repetido con datos de otro participante (colisión de
    // UUID) es prácticamente imposible; cualquier otro error de validación
    // que se nos haya escapado cae acá como 400, no como 500.
    res.status(400).json({ error: "lote inválido", detail: err.message });
  }
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
