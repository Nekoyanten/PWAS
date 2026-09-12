import { Router } from "express";
import { query } from "../db.js";
import { buildSurveySchema, debriefText } from "../lib/survey.js";
import {
  renderWelcome, renderCalibration, renderApp, renderMessage, renderStimulusLanding,
  renderActionDone, renderSurvey, renderDebrief, renderInvalid,
  renderJoltingInterstitial,
} from "../lib/decoy.js";
import { scoreAndStoreDeliveryRisk } from "../lib/riskScore.js";
import { resolveMessageFields, insertMessage, createDeliveryForParticipant } from "../lib/messageFactory.js";
import * as boards from "../lib/boards.js";
import * as chat from "../lib/chat.js";

export const trackingRouter = Router();

// Rutas PÚBLICAS del participante (solo token, sin x-api-key). Ningún endpoint
// persiste contenido escrito por el participante. Ver nota en schema.sql.

const HTML = { "Content-Type": "text/html; charset=utf-8" };

async function loadPC(token) {
  const r = await query(
    `SELECT pc.id, pc.participant_id, pc.campaign_id, pc.access_token,
            pc.session_started_at, pc.finished_at,
            pc.calibration_started_at, pc.calibration_completed_at,
            pc.practice_username, pc.practice_password,
            p.consent_given, p.group_assignment,
            p.camera_consent_given,
            c.name AS campaign_name, c.status AS campaign_status
     FROM participant_campaign pc
     JOIN participants p ON p.id = pc.participant_id
     JOIN campaigns c ON c.id = pc.campaign_id
     WHERE pc.access_token = $1`,
    [token]
  );
  return r.rows[0] ?? null;
}

// TG §8.2.5 / §9.2: solo el grupo 'experimental' es CANDIDATO a recibir la
// capa de intervención (jolting). 'control' y participantes sin grupo
// asignado (p.ej. datos de campañas antiguas o importados sin
// group_assignment) mantienen el flujo original, sin interstitial, siempre.
function isExperimental(pc) {
  return pc.group_assignment === "experimental";
}

// Migración 006 — adaptatividad: ser del grupo experimental ya NO basta por
// sí solo para ver el aviso. También hace falta que:
//   (a) el propio mensaje lo permita (messages.jolting_enabled) — el admin
//       puede marcar un ataque como "silencioso" y entonces nunca lo
//       muestra, a nadie; y
//   (b) el sorteo de ESTE envío haya salido positivo (deliveries.jolting_roll,
//       fijado una sola vez al enviarlo — ver rollJolting() en messages.js).
// Antes de esta migración (a) y (b) no existían y el resultado para
// experimental era "siempre sí"; ahora depende de campaigns.jolting_probability.
// Sin este control de variabilidad, todo el grupo experimental ve el aviso
// en el 100% de los ataques y lo que se termina midiendo es "¿ignora una
// advertencia explícita?" en vez de "¿cae en el engaño en condiciones
// realistas?" — exactamente la limitación que motivó este cambio.
function joltingEligible(pc, d) {
  return isExperimental(pc) && d.jolting_enabled === true && d.jolting_roll === true;
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
    `SELECT d.id AS delivery_id, d.delivered_at, d.jolting_roll,
            m.id AS message_id, m.template_id, m.kind, m.is_attack, m.vector, m.sender_label,
            m.subject, m.body, m.cta_label, m.landing_kind, m.landing_config, m.jolting_enabled
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
  if (!pc.calibration_completed_at) return res.redirect(`/t/${t}/calibration`);
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
  // Consentimiento de cámara: SEPARADO del de arriba (ver migración 015 y
  // renderWelcome) -- un checkbox sin marcar simplemente no manda el campo,
  // así que la ausencia se trata igual que "no acepto", nunca como error.
  const cameraOk = req.body && (req.body.camera_consent === "1" || req.body.camera_consent === 1 || req.body.camera_consent === true);
  if (cameraOk && !pc.camera_consent_given) {
    await query(`UPDATE participants SET camera_consent_given = TRUE, camera_consent_timestamp = now() WHERE id = $1 AND camera_consent_given = FALSE`, [pc.participant_id]);
  }
  // Paso 2 del protocolo (TG §9.5): calibración antes del tablero, no
  // directo a /app — ver renderCalibration() para el porqué.
  res.redirect(`/t/${encodeURIComponent(pc.access_token)}/calibration`);
});

// Paso 2 del protocolo: calibración de ~30s (línea base de mouse/teclado)
// entre el consentimiento y la tarea de navegación. Se muestra una sola vez;
// revisitar el enlace después de completarla salta directo a /app (mismo
// criterio que la intervención con `interventionAlreadyShown`).
trackingRouter.get("/:token/calibration", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  if (!pc.consent_given) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}`);
  if (pc.calibration_completed_at) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}/app`);
  if (!pc.calibration_started_at) {
    await query(`UPDATE participant_campaign SET calibration_started_at = now() WHERE id = $1 AND calibration_started_at IS NULL`, [pc.id]);
  }
  res.set(HTML).send(renderCalibration(pc.access_token, pc.camera_consent_given));
});

trackingRouter.post("/:token/calibration/complete", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  if (!pc.consent_given) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}`);
  if (!pc.calibration_completed_at) {
    // COALESCE en calibration_started_at por robustez: en el flujo normal
    // siempre se pasó primero por GET /calibration (que ya lo puso), pero
    // esta ruta no debería depender de eso para dejar un registro coherente
    // si algún día se llama de otra forma (p.ej. un reintento de red).
    await query(
      `UPDATE participant_campaign
       SET calibration_completed_at = now(), calibration_started_at = COALESCE(calibration_started_at, now())
       WHERE id = $1 AND calibration_completed_at IS NULL`,
      [pc.id]
    );
  }
  res.redirect(`/t/${encodeURIComponent(pc.access_token)}/app`);
});

trackingRouter.get("/:token/app", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  if (!pc.consent_given) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}`);
  // No se puede saltar la calibración yendo directo a /app por URL: es un
  // paso obligatorio del protocolo (TG §9.5), no una sugerencia.
  if (!pc.calibration_completed_at) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}/calibration`);
  if (!pc.session_started_at) {
    await query(`UPDATE participant_campaign SET session_started_at = now() WHERE id = $1 AND session_started_at IS NULL`, [pc.id]);
  }
  const inbox = await buildInbox(pc.id);
  const [boardsData, contacts, boardTemplates] = await Promise.all([
    boards.loadBoards(pc.id),
    query(`SELECT * FROM fictitious_contacts WHERE campaign_id = $1 ORDER BY display_name`, [pc.campaign_id]).then((r) => r.rows),
    query(`SELECT id, name FROM board_templates WHERE campaign_id = $1 ORDER BY created_at`, [pc.campaign_id]).then((r) => r.rows),
  ]);
  res.set(HTML).send(renderApp(pc.access_token, { inbox, view: req.query.v, boardsData, contacts, boardTemplates, cameraConsent: pc.camera_consent_given }));
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
  // Árbol de respuestas (migración 010): si esta plantilla tiene ramas
  // definidas, se ofrecen como botones de respuesta rápida junto a
  // "Abrir"/"Reportar" -- ver POST /d/:deliveryId/branch.
  const branches = d.template_id
    ? (await query(`SELECT action_key, action_label FROM message_branches WHERE from_template_id = $1 ORDER BY created_at`, [d.template_id])).rows
    : [];
  res.set(HTML).send(renderMessage(pc.access_token, {
    deliveryId: d.delivery_id, kind: d.kind, is_attack: d.is_attack,
    from: d.sender_label || (d.kind === "task" ? "TaskFlow" : "Notificaciones"),
    subject: d.subject, body: d.body, cta_label: d.cta_label, branches,
    cameraConsent: pc.camera_consent_given,
  }));
});

// CTA del estímulo. Grupo control (o sin grupo), o mensaje/sorteo no
// elegible (joltingEligible() = false): comportamiento original, directo al
// aterrizaje. Grupo experimental + mensaje con jolting_enabled + sorteo
// positivo, primera vez sobre este delivery: se interpone la capa de
// intervención (jolting, TG §8.2.5) antes de dejar pasar al aterrizaje o de
// permitir cancelar.
trackingRouter.get("/:token/d/:deliveryId/go", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).set(HTML).send(renderInvalid());
  const d = await loadDelivery(pc.id, req.params.deliveryId);
  if (!pc.consent_given || !d || !d.is_attack) return res.redirect(`/t/${encodeURIComponent(pc.access_token)}/app`);

  // TG §8.2.5 / migración 007, MODO SOMBRA: calcula el puntaje de riesgo del
  // modelo temporal sobre la captura conductual de este participante en este
  // mensaje, EN SEGUNDO PLANO -- disparado recién cuando la respuesta YA
  // terminó de enviarse (res.on("finish")), para que ni el cálculo ni la
  // conexión a la base de datos que usa puedan retrasar ni en un milisegundo
  // lo que ve el participante. En un piloto de laboratorio con gente
  // entrando y saliendo, una demora perceptible en una página que simula ser
  // normal sería en sí misma una pista. Se guarda para análisis; todavía NO
  // decide si se muestra la intervención (eso lo sigue haciendo
  // joltingEligible de abajo, sin cambios) porque el modelo se entrenó con
  // etiquetas sintéticas -- ver docs/2026-09-07_motor-decision-riesgo.md.
  res.on("finish", () => {
    scoreAndStoreDeliveryRisk(d.delivery_id).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[riskScore] fallo calculando riesgo para delivery ${d.delivery_id}:`, err);
    });
  });

  if (joltingEligible(pc, d) && !(await interventionAlreadyShown(d.delivery_id))) {
    await recordOnce(pc.id, d.delivery_id, "intervencion_mostrada", reactionMs(d.delivered_at));
    return res.set(HTML).send(renderJoltingInterstitial(pc.access_token, { deliveryId: d.delivery_id }));
  }

  await recordOnce(pc.id, d.delivery_id, "abierto", reactionMs(d.delivered_at));
  await recordOnce(pc.id, d.delivery_id, "clic", reactionMs(d.delivered_at));
  res.set(HTML).send(renderStimulusLanding(pc.access_token, {
    deliveryId: d.delivery_id, landing_kind: d.landing_kind || "form", landing_config: d.landing_config || {},
    cameraConsent: pc.camera_consent_given,
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
    cameraConsent: pc.camera_consent_given,
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

// Migración 010: si el participante tiene credenciales de práctica
// asignadas (participant_campaign.practice_username/password -- NO son
// credenciales reales de nadie, ver migración), compara EN MEMORIA lo que
// escribió contra esas dos cadenas y guarda solo el resultado
// (deliveries.credential_match_result). El texto escrito nunca toca una
// variable que sobreviva esta función, ni se loguea: mismo principio que ya
// aplicaba a 'intento_envio' antes de esta migración, extendido en vez de
// debilitado por el hecho de que ahora sí exista "la respuesta correcta".
function checkCredentialMatch(pc, body) {
  if (!pc.practice_username || !pc.practice_password) return null;
  const u = typeof body?.u === "string" ? body.u : "";
  const p = typeof body?.p === "string" ? body.p : "";
  return u === pc.practice_username && p === pc.practice_password;
}

trackingRouter.post("/:token/d/:deliveryId/submit", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).json({ error: "Enlace no válido." });
  const d = await loadDelivery(pc.id, req.params.deliveryId);
  if (!d) return res.status(404).json({ error: "Mensaje no encontrado." });
  await recordOnce(pc.id, d.delivery_id, "intento_envio", reactionMs(d.delivered_at));

  const match = checkCredentialMatch(pc, req.body);
  if (match !== null) {
    await query(`UPDATE deliveries SET credential_match_result = $1 WHERE id = $2`, [match, d.delivery_id]);
  }
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
// Tableros reales (migración 010). Antes solo existían en localStorage del
// navegador (invisibles para el equipo); ahora son filas de verdad, para que
// un mensaje de ataque pueda referenciar una tarea/tablero real que el
// propio participante creó (ver docs/2026-09-09_diversificacion-vectores-
// ataque.md, "gancho de pretexto"). El "responsable" de una tarea siempre es
// un fictitious_contacts.id -- nunca texto libre -- para no dejar entrar por
// esta puerta el nombre real de un compañero de trabajo de verdad.

trackingRouter.get("/:token/boards.json", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc || !pc.consent_given) return res.status(404).json({ error: "no" });
  res.json({ boards: await boards.loadBoards(pc.id) });
});

trackingRouter.get("/:token/board-templates.json", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc || !pc.consent_given) return res.status(404).json({ error: "no" });
  const r = await query(`SELECT id, name FROM board_templates WHERE campaign_id = $1 ORDER BY created_at`, [pc.campaign_id]);
  res.json({ board_templates: r.rows });
});

trackingRouter.get("/:token/contacts.json", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc || !pc.consent_given) return res.status(404).json({ error: "no" });
  const r = await query(`SELECT id, display_name, role_label, avatar_color FROM fictitious_contacts WHERE campaign_id = $1 ORDER BY display_name`, [pc.campaign_id]);
  res.json({ contacts: r.rows });
});

trackingRouter.post("/:token/boards", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc || !pc.consent_given) return res.status(404).json({ error: "Enlace no válido." });
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
  if (!name) return res.status(400).json({ error: "Falta 'name'" });
  const templateId = typeof req.body?.template_id === "string" ? req.body.template_id : null;
  const board = await boards.createBoard(pc.id, { name, templateId });
  res.status(201).json({ board });
});

trackingRouter.post("/:token/boards/:boardId/tasks", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc || !pc.consent_given) return res.status(404).json({ error: "Enlace no válido." });
  if (!(await boards.assertBoardOwnership(req.params.boardId, pc.id))) return res.status(404).json({ error: "Tablero no encontrado" });
  const { column_id, title, description, responsible_contact_id, priority, checklist } = req.body ?? {};
  const titleTrim = typeof title === "string" ? title.trim().slice(0, 200) : "";
  if (!column_id || !titleTrim) return res.status(400).json({ error: "Campos requeridos: column_id, title" });
  if (!(await boards.assertColumnInBoard(column_id, req.params.boardId))) return res.status(400).json({ error: "La columna no pertenece a este tablero" });
  const task = await boards.createTask(column_id, {
    title: titleTrim,
    description: typeof description === "string" ? description.slice(0, 2000) : null,
    responsible_contact_id: responsible_contact_id || null,
    priority,
    checklist,
  });
  res.status(201).json({ task });
});

trackingRouter.patch("/:token/boards/:boardId/tasks/:taskId", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc || !pc.consent_given) return res.status(404).json({ error: "Enlace no válido." });
  if (!(await boards.assertBoardOwnership(req.params.boardId, pc.id))) return res.status(404).json({ error: "Tablero no encontrado" });
  if ((await boards.taskBoardId(req.params.taskId)) !== req.params.boardId) return res.status(404).json({ error: "Tarea no encontrada en este tablero" });
  const { column_id, title, description, responsible_contact_id, position, priority, checklist } = req.body ?? {};
  if (column_id && !(await boards.assertColumnInBoard(column_id, req.params.boardId))) {
    return res.status(400).json({ error: "La columna destino no pertenece a este tablero" });
  }
  // priority/checklist solo se incluyen en el objeto si el participante los
  // mandó -- boards.updateTask distingue "no venía" de "media"/"[]" con
  // fields.priority !== undefined, así que agregar la clave con `null` acá
  // rompería esa distinción.
  const patch = {
    title: typeof title === "string" ? title.trim().slice(0, 200) : null,
    description: typeof description === "string" ? description.slice(0, 2000) : null,
    responsible_contact_id: responsible_contact_id ?? null,
    column_id: column_id ?? null,
    position: Number.isInteger(position) ? position : null,
  };
  if (priority !== undefined) patch.priority = priority;
  if (checklist !== undefined) patch.checklist = checklist;
  const task = await boards.updateTask(req.params.taskId, patch);
  if (!task) return res.status(404).json({ error: "Tarea no encontrada" });
  res.json({ task });
});

trackingRouter.delete("/:token/boards/:boardId/tasks/:taskId", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc || !pc.consent_given) return res.status(404).json({ error: "Enlace no válido." });
  if (!(await boards.assertBoardOwnership(req.params.boardId, pc.id))) return res.status(404).json({ error: "Tablero no encontrado" });
  if ((await boards.taskBoardId(req.params.taskId)) !== req.params.boardId) return res.status(404).json({ error: "Tarea no encontrada en este tablero" });
  const ok = await boards.deleteTask(req.params.taskId);
  if (!ok) return res.status(404).json({ error: "Tarea no encontrada" });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Chat persistente (migración 010). Se instancia (guion + ataques inyectados)
// la primera vez que el participante abre la vista; después solo se agregan
// respuestas suyas y, si aplica, nuevos ataques que lleguen por una rama del
// árbol de respuestas (ver /:token/d/:deliveryId/branch más abajo).
trackingRouter.get("/:token/chat.json", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc || !pc.consent_given) return res.status(404).json({ error: "no" });
  const { thread } = await chat.getOrCreateThread(pc);
  const messages = await chat.loadThreadMessages(thread.id);
  res.json({ thread_id: thread.id, messages });
});

trackingRouter.post("/:token/chat/reply", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc || !pc.consent_given) return res.status(404).json({ error: "Enlace no válido." });
  const body = typeof req.body?.body === "string" ? req.body.body.trim().slice(0, 1000) : "";
  if (!body) return res.status(400).json({ error: "Falta 'body'" });
  const { thread } = await chat.getOrCreateThread(pc);
  const msg = await chat.appendReply(thread.id, body);
  // Sin delivery_id: esto es una respuesta libre dentro del chat, no ligada
  // a un mensaje de ataque concreto (para eso está la rama de abajo,
  // /d/:deliveryId/branch, que sí registra el evento contra un delivery).
  await query(`INSERT INTO events (participant_campaign_id, event_type, detail) VALUES ($1, 'respuesta_participante', 'chat_libre')`, [pc.id]);
  res.status(201).json({ message: msg });
});

// ---------------------------------------------------------------------------
// Árbol de respuestas (migración 010, opción "a"): el participante elige una
// acción prediseñada sobre un mensaje de ataque (correo o chat) y el sistema
// crea el siguiente mensaje/delivery de la conversación a partir de la
// plantilla que el admin enlazó para esa acción (message_branches). Si el
// mensaje original llegó por chat, el nuevo también se agrega al mismo hilo;
// si llegó por correo, aparece como un mensaje nuevo en la bandeja (mismo
// patrón que cualquier delivery).
trackingRouter.post("/:token/d/:deliveryId/branch", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(404).json({ error: "Enlace no válido." });
  const d = await loadDelivery(pc.id, req.params.deliveryId);
  if (!d || !d.is_attack) return res.status(404).json({ error: "Mensaje no encontrado." });
  const actionKey = typeof req.body?.action_key === "string" ? req.body.action_key : "";
  if (!actionKey) return res.status(400).json({ error: "Falta 'action_key'" });

  if (!d.template_id) return res.status(400).json({ error: "Este mensaje no viene de una plantilla; no tiene ramas definidas." });
  const branch = await query(
    `SELECT * FROM message_branches WHERE from_template_id = $1 AND action_key = $2`,
    [d.template_id, actionKey]
  );
  if (branch.rows.length === 0) return res.status(404).json({ error: "Esa acción no está disponible para este mensaje." });

  await recordOnce(pc.id, d.delivery_id, "respuesta_participante", reactionMs(d.delivered_at), actionKey);

  const campaign = await query(`SELECT seed, jolting_probability FROM campaigns WHERE id = $1`, [pc.campaign_id]);
  const resolved = await resolveMessageFields(
    { template_id: branch.rows[0].to_template_id },
    { parent_message_id: d.message_id, branch_action_key: actionKey }
  );
  if (resolved.error) return res.status(500).json({ error: resolved.error });
  const nextMessage = await insertMessage(pc.campaign_id, resolved.fields);
  const nextDelivery = await createDeliveryForParticipant({
    message: { id: nextMessage.id, jolting_probability: campaign.rows[0].jolting_probability },
    campaignSeed: campaign.rows[0].seed,
    participantCampaignId: pc.id,
  });

  // Si el mensaje original llegó por chat, el siguiente también se inyecta
  // en el mismo hilo (mismo remitente ficticio que dijo lo anterior, si lo
  // hay) -- para que sea una conversación continua, no un salto a la bandeja.
  if (d.kind === "chat" && nextDelivery) {
    const senderRow = await query(
      `SELECT sender_contact_id FROM chat_messages WHERE delivery_id = $1 LIMIT 1`,
      [d.delivery_id]
    );
    await chat.appendAttackToThread(pc.id, nextDelivery.id, senderRow.rows[0]?.sender_contact_id ?? null);
  }

  res.status(201).json({
    message: nextMessage,
    delivery: nextDelivery,
    appended_to_chat: d.kind === "chat" && !!nextDelivery,
  });
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

// ---------------------------------------------------------------------------
// Captura biométrica facial (extensión fuera del alcance original de TG
// §8.2 Fase 1 -- ver docs/2026-09-12_captura-facial-biometrica.md y la
// migración 015). Ver apps/api/public/js/facial-capture.js para qué envía el
// navegador y por qué: solo 5 escalares derivados de blendshapes de
// MediaPipe (nunca video, imágenes ni landmarks/blendshapes crudos). Este
// endpoint solo valida y guarda -- mismo criterio que POST /:token/behavior,
// deliberadamente NO usa recordOnce/dedup porque cada muestra es la señal en
// sí, no un evento de negocio.
const FACIAL_MAX_SAMPLES_PER_REQUEST = 200; // debe calzar con MAX_SAMPLES_PER_REQUEST en facial-capture.js.

// Clamp amplio [-1,1]: eye_openness/brow_tension/mouth_tension viven en
// [0,1] y gaze_x/gaze_y en aprox. [-1,1] -- un solo clamp común alcanza para
// las cuatro, sin necesitar distinguir cuál campo es cuál aquí.
function clampSignalFloat(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(-1, n));
}

function sanitizeFacialSample(raw) {
  if (!raw || typeof raw !== "object") return null;
  const t = clampInt(raw.t, 0, 24 * 60 * 60 * 1000);
  if (t === null) return null;
  const faceDetected = raw.fd === true;
  if (!faceDetected) {
    return { t_ms: t, event_type: "facial_sample", face_detected: false, eye_openness: null, blink: null, gaze_x: null, gaze_y: null, brow_tension: null, mouth_tension: null };
  }
  return {
    t_ms: t,
    event_type: "facial_sample",
    face_detected: true,
    eye_openness: clampSignalFloat(raw.eo),
    blink: raw.bl === true,
    gaze_x: clampSignalFloat(raw.gx),
    gaze_y: clampSignalFloat(raw.gy),
    brow_tension: clampSignalFloat(raw.bt),
    mouth_tension: clampSignalFloat(raw.mt),
  };
}

const FACIAL_EVENT_COLUMNS = 10; // facial_session_id, t_ms, event_type, face_detected, eye_openness, blink, gaze_x, gaze_y, brow_tension, mouth_tension

async function insertFacialEvents(sessionId, samples) {
  const values = [];
  const placeholders = samples.map((s, i) => {
    const base = i * FACIAL_EVENT_COLUMNS;
    values.push(sessionId, s.t_ms, s.event_type, s.face_detected, s.eye_openness, s.blink, s.gaze_x, s.gaze_y, s.brow_tension, s.mouth_tension);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
  });
  await query(
    `INSERT INTO facial_events (facial_session_id, t_ms, event_type, face_detected, eye_openness, blink, gaze_x, gaze_y, brow_tension, mouth_tension)
     VALUES ${placeholders.join(", ")}`,
    values
  );
}

trackingRouter.post("/:token/facial", async (req, res) => {
  const pc = await loadPC(req.params.token);
  if (!pc) return res.status(204).end(); // mismo criterio que /behavior: un token vencido no debe romper la página del participante.
  if (!pc.camera_consent_given) return res.status(204).end(); // sin consentimiento de cámara, se ignora cualquier lote (defensa en profundidad: el script ni debería estar cargado).

  const body = req.body ?? {};
  if (!UUID_RE.test(body.session_id || "")) return res.status(400).json({ error: "session_id inválido" });
  if (typeof body.phase !== "string" || !body.phase) return res.status(400).json({ error: "phase requerido" });
  if (!Array.isArray(body.samples) || body.samples.length === 0) return res.status(400).json({ error: "samples requerido" });
  if (body.samples.length > FACIAL_MAX_SAMPLES_PER_REQUEST) {
    return res.status(400).json({ error: `máximo ${FACIAL_MAX_SAMPLES_PER_REQUEST} muestras por request` });
  }
  const deliveryId = typeof body.delivery_id === "string" && UUID_RE.test(body.delivery_id) ? body.delivery_id : null;

  const samples = body.samples.map(sanitizeFacialSample).filter(Boolean);
  if (samples.length === 0) return res.status(400).json({ error: "ninguna muestra válida en el lote" });

  try {
    await query(
      `INSERT INTO facial_sessions (id, participant_campaign_id, delivery_id, phase, camera_w, camera_h, sample_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         last_flush_at = now(),
         sample_count = facial_sessions.sample_count + EXCLUDED.sample_count`,
      [
        body.session_id, pc.id, deliveryId, body.phase.slice(0, 40),
        clampInt(body.camera_w, 0, 32767), clampInt(body.camera_h, 0, 32767),
        samples.length,
      ]
    );
    await insertFacialEvents(body.session_id, samples);
    res.status(204).end();
  } catch (err) {
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
  res.set(HTML).send(renderSurvey(pc.access_token, buildSurveySchema(attack ? attack.vector : null), pc.camera_consent_given));
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
