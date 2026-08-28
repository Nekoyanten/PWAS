import { Router } from "express";
import { query } from "../db.js";
import { buildSurveySchema, debriefText } from "../lib/survey.js";
import {
  renderWelcome, renderApp, renderMessage, renderStimulusLanding,
  renderActionDone, renderSurvey, renderDebrief, renderInvalid,
} from "../lib/decoy.js";

export const trackingRouter = Router();

// Todas las rutas de este archivo son PÚBLICAS (las visita el participante,
// no un administrador) y de propósito único: solo aceptan el token opaco,
// nunca un identificador de participante legible. No requieren x-api-key.
//
// NINGÚN endpoint aquí persiste contenido escrito por el participante:
// /submit descarta el body, /grant solo guarda la etiqueta del permiso,
// /usability solo incrementa un contador. Ver nota de cumplimiento en schema.sql.

const HTML = { "Content-Type": "text/html; charset=utf-8" };

async function loadPC(token) {
  const r = await query(
    `SELECT pc.id, pc.participant_id, pc.campaign_id, pc.access_token,
            pc.delivered_at, pc.session_started_at, pc.usability_interactions, pc.finished_at,
            pc.assigned_template_id,
            p.consent_given,
            c.name AS campaign_name, c.status AS campaign_status, c.template_id AS campaign_template_id,
            t.id AS tpl_id, t.vector, t.sender_label, t.subject_or_headline,
            t.message_body, t.cta_label, t.landing_kind, t.landing_config
     FROM participant_campaign pc
     JOIN participants p ON p.id = pc.participant_id
     JOIN campaigns c ON c.id = pc.campaign_id
     LEFT JOIN templates t ON t.id = COALESCE(pc.assigned_template_id, c.template_id)
     WHERE pc.access_token = $1`,
    [token]
  );
  return r.rows[0] ?? null;
}

function reactionMs(pc) {
  if (!pc.delivered_at) return null;
  return Date.now() - new Date(pc.delivered_at).getTime();
}

async function recordEventOnce(pcId, eventType, reaction = null, detail = null) {
  const existing = await query(
    `SELECT id FROM events WHERE participant_campaign_id = $1 AND event_type = $2`,
    [pcId, eventType]
  );
  if (existing.rows.length > 0) return existing.rows[0];
  const r = await query(
    `INSERT INTO events (participant_campaign_id, event_type, reaction_time_ms, detail)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [pcId, eventType, reaction, detail]
  );
  return r.rows[0];
}

// Mensajes de la bandeja: 2 benignos fijos + el estímulo (si fue entregado).
async function buildMessages(pc) {
  const msgs = [
    { id: "m1", from: "Equipo TaskFlow", subject: "Bienvenido/a al piloto de TaskFlow",
      body: "Gracias por participar. Usa el tablero con normalidad: mueve tarjetas entre columnas, marca tareas como hechas y revisa esta bandeja. Cuando termines, pulsa \"Finalizar piloto\".", kind: "info", unread: false },
    { id: "m2", from: "Calendario del equipo", subject: "Recordatorio: reunión de seguimiento el viernes",
      body: "La reunión semanal de seguimiento será el viernes a las 10:00 en la sala habitual. Recuerda actualizar tus tarjetas antes.", kind: "info", unread: false },
  ];
  if (pc.delivered_at && pc.tpl_id) {
    const opened = await query(
      `SELECT 1 FROM events WHERE participant_campaign_id = $1 AND event_type = 'abierto'`,
      [pc.id]
    );
    msgs.splice(1, 0, {
      id: "stim",
      from: pc.sender_label || "Notificaciones",
      subject: pc.subject_or_headline || "Acción requerida",
      body: pc.message_body || "Se requiere una acción de tu parte. Pulsa el botón para continuar.",
      cta_label: pc.cta_label || "Abrir",
      kind: "stimulus",
      unread: opened.rows.length === 0,
    });
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// Entrada: decide a qué pantalla llevar al participante.
trackingRouter.get("/:token", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  if (!pc.consent_given) return res.set(HTML).send(renderWelcome(pc.access_token, pc.campaign_name));
  if (pc.finished_at || pc.campaign_status === "finalizada") return res.redirect(`/t/${encodeURIComponent(pc.access_token)}/survey`);
  return res.redirect(`/t/${encodeURIComponent(pc.access_token)}/app`);
});

trackingRouter.post("/:token/consent", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  if (!req.body || (req.body.consent !== "1" && req.body.consent !== 1 && req.body.consent !== true)) {
    return res.set(HTML).send(renderWelcome(pc.access_token, pc.campaign_name));
  }
  if (!pc.consent_given) {
    await query(
      `UPDATE participants SET consent_given = TRUE, consent_timestamp = now()
       WHERE id = $1 AND consent_given = FALSE`,
      [pc.participant_id]
    );
  }
  res.redirect(`/t/${encodeURIComponent(pc.access_token)}/app`);
});

// ---------------------------------------------------------------------------
// App señuelo.
trackingRouter.get("/:token/app", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  if (!pc.consent_given) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}`);

  if (!pc.session_started_at) {
    await query(`UPDATE participant_campaign SET session_started_at = now() WHERE id = $1 AND session_started_at IS NULL`, [pc.id]);
  }
  const messages = await buildMessages(pc);
  res.set(HTML).send(renderApp(pc.access_token, {
    campaignName: pc.campaign_name, messages, finished: !!pc.finished_at,
  }));
});

// Ver un mensaje de la bandeja. Abrir el mensaje-estímulo cuenta como 'abierto'.
trackingRouter.get("/:token/message/:mid", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  if (!pc.consent_given) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}`);

  const messages = await buildMessages(pc);
  const msg = messages.find((m) => m.id === req.params.mid);
  if (!msg) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}/app`);

  if (msg.kind === "stimulus") {
    await recordEventOnce(pc.id, "abierto", reactionMs(pc));
  }
  res.set(HTML).send(renderMessage(pc.access_token, msg));
});

// CTA del estímulo -> 'clic' + página de aterrizaje.
trackingRouter.get("/:token/stimulus", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  if (!pc.consent_given || !pc.tpl_id) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}/app`);

  await recordEventOnce(pc.id, "abierto", reactionMs(pc)); // por si llega directo sin abrir el mensaje
  await recordEventOnce(pc.id, "clic", reactionMs(pc));
  res.set(HTML).send(renderStimulusLanding(pc.access_token, {
    landing_kind: pc.landing_kind || "form",
    landing_config: pc.landing_config || {},
  }));
});

// Intento de envío del formulario señuelo. El body se descarta SIEMPRE.
trackingRouter.post("/:token/submit", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).json({ error: "Enlace no válido." });
  await recordEventOnce(pc.id, "intento_envio", reactionMs(pc));
  // Respuesta doble: JSON para el fetch del formulario, o redirección si vino sin JS.
  if ((req.headers.accept || "").includes("application/json") || req.is("application/json")) {
    return res.json({ ok: true, message: "Registrado. Ningún dato ingresado fue almacenado." });
  }
  res.redirect(`/t/${encodeURIComponent(pc.access_token)}/action-done`);
});

// "Permitir" en el diálogo de permiso SIMULADO. Solo se guarda la etiqueta.
trackingRouter.post("/:token/grant", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).json({ error: "Enlace no válido." });
  const permisoRaw = (req.body && (req.body.permiso || req.body.permission)) || "desconocido";
  const permiso = String(permisoRaw).slice(0, 40).replace(/[^a-z_]/gi, "");
  await recordEventOnce(pc.id, "permiso_concedido", reactionMs(pc), permiso || "desconocido");
  res.redirect(`/t/${encodeURIComponent(pc.access_token)}/action-done`);
});

trackingRouter.get("/:token/action-done", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  res.set(HTML).send(renderActionDone(pc.access_token));
});

// El participante reporta el mensaje como sospechoso.
trackingRouter.post("/:token/report", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).json({ error: "Enlace no válido." });
  await recordEventOnce(pc.id, "reportado", reactionMs(pc));
  res.json({ ok: true });
});

// Telemetría de usabilidad benigna: solo un contador. Sin contenido.
trackingRouter.post("/:token/usability", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(204).end();
  await query(
    `UPDATE participant_campaign
       SET usability_interactions = LEAST(usability_interactions + 1, 100000)
     WHERE id = $1`,
    [pc.id]
  );
  res.status(204).end();
});

// Finalizar piloto -> pasa a la encuesta.
trackingRouter.post("/:token/finish", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  if (!pc.finished_at) {
    await query(`UPDATE participant_campaign SET finished_at = now() WHERE id = $1 AND finished_at IS NULL`, [pc.id]);
  }
  res.redirect(`/t/${encodeURIComponent(pc.access_token)}/survey`);
});

// ---------------------------------------------------------------------------
// Encuesta adaptada al vector + debriefing.
trackingRouter.get("/:token/survey", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  if (!pc.consent_given) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}`);
  if (!pc.finished_at && pc.campaign_status !== "finalizada") {
    return res.redirect(`/t/${encodeURIComponent(pc.access_token)}/app`);
  }
  const already = await query(`SELECT 1 FROM post_session_survey WHERE participant_campaign_id = $1`, [pc.id]);
  if (already.rows.length > 0) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}/debrief`);

  const schema = buildSurveySchema(pc.vector || "autoridad");
  res.set(HTML).send(renderSurvey(pc.access_token, schema));
});

trackingRouter.post("/:token/survey", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).json({ error: "Enlace no válido." });

  const body = req.body ?? {};
  const toBool = (v) => (v === "true" || v === true ? true : v === "false" || v === false ? false : null);

  // fell_for_attack se calcula de los eventos reales, no del autorreporte.
  const fellRes = await query(
    `SELECT EXISTS (
       SELECT 1 FROM events
       WHERE participant_campaign_id = $1
         AND event_type IN ('clic', 'intento_envio', 'permiso_concedido')
     ) AS fell`,
    [pc.id]
  );
  const fell = fellRes.rows[0].fell;

  const validReasons = ["miedo_sancion", "promesa_beneficio", "confianza_remitente", "urgencia_temporal", "prueba_social", "curiosidad", "no_aplica"];
  const fallReason = validReasons.includes(body.fall_reason) ? body.fall_reason : "no_aplica";

  await query(
    `INSERT INTO post_session_survey
       (participant_campaign_id, fell_for_attack, fall_reason,
        perceived_suspicion_before_action, recognized_as_simulated,
        vector_specific_answer, free_comment)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (participant_campaign_id) DO UPDATE SET
       fell_for_attack = EXCLUDED.fell_for_attack,
       fall_reason = EXCLUDED.fall_reason,
       perceived_suspicion_before_action = EXCLUDED.perceived_suspicion_before_action,
       recognized_as_simulated = EXCLUDED.recognized_as_simulated,
       vector_specific_answer = EXCLUDED.vector_specific_answer,
       free_comment = EXCLUDED.free_comment`,
    [
      pc.id, fell, fallReason,
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
  res.set(HTML).send(renderDebrief(debriefText(pc.vector || "autoridad")));
});
