import { Router } from "express";
import { query, withTransaction } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { generateAccessToken } from "../lib/tokens.js";
import { assignBalanced } from "../lib/rng.js";

export const campaignsRouter = Router();

const VALID_STATUS = ["borrador", "programada", "en_curso", "finalizada", "cancelada"];

campaignsRouter.post("/", requireAdmin, async (req, res) => {
  const { name, template_id, template_ids, seed, scheduled_at } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "Campo requerido: name" });
  const pool = Array.isArray(template_ids) ? template_ids.filter(Boolean) : [];

  const result = await query(
    `INSERT INTO campaigns (name, template_id, seed, scheduled_at, status)
     VALUES ($1, $2, COALESCE($3, substr(md5(random()::text),1,12)), $4, 'borrador') RETURNING *`,
    [name, template_id ?? pool[0] ?? null, seed ?? null, scheduled_at ?? null]
  );
  const campaign = result.rows[0];
  for (const tid of pool) {
    await query(`INSERT INTO campaign_templates (campaign_id, template_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [campaign.id, tid]);
  }
  res.status(201).json({ campaign });
});

campaignsRouter.get("/", requireAdmin, async (req, res) => {
  const result = await query(
    `SELECT c.*,
       (SELECT COUNT(*) FROM campaign_templates ct WHERE ct.campaign_id = c.id) AS pool_size,
       (SELECT COUNT(*) FROM participant_campaign pc WHERE pc.campaign_id = c.id) AS links,
       (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = c.id) AS messages,
       (SELECT COUNT(*) FROM deliveries d JOIN participant_campaign pc ON pc.id = d.participant_campaign_id
          WHERE pc.campaign_id = c.id) AS deliveries
     FROM campaigns c ORDER BY c.created_at DESC`
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
  res.json({ campaign: c.rows[0], pool: pool.rows });
});

campaignsRouter.put("/:id", requireAdmin, async (req, res) => {
  const { name, seed, template_id, template_ids } = req.body ?? {};
  const updated = await query(
    `UPDATE campaigns SET name = COALESCE($1, name), seed = COALESCE($2, seed), template_id = COALESCE($3, template_id)
     WHERE id = $4 RETURNING *`,
    [name ?? null, seed ?? null, template_id ?? null, req.params.id]
  );
  if (updated.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  if (Array.isArray(template_ids)) {
    await query(`DELETE FROM campaign_templates WHERE campaign_id = $1`, [req.params.id]);
    for (const tid of template_ids.filter(Boolean)) {
      await query(`INSERT INTO campaign_templates (campaign_id, template_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, tid]);
    }
  }
  res.json({ campaign: updated.rows[0] });
});

campaignsRouter.patch("/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body ?? {};
  if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: `status inválido: ${VALID_STATUS.join("|")}` });
  const r = await query(`UPDATE campaigns SET status = $1 WHERE id = $2 RETURNING *`, [status, req.params.id]);
  if (r.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  res.json({ campaign: r.rows[0] });
});

// Migración 006: probabilidad (0..1) de que un mensaje con jolting_enabled
// muestre el aviso de intervención al grupo experimental. Solo aplica a
// envíos FUTUROS (mensajes que aún no se hayan enviado con /messages/:id/send)
// — los deliveries ya creados guardan su propio sorteo fijo
// (deliveries.jolting_roll) y no se recalculan al cambiar esto, por la misma
// razón por la que no se re-asigna el grupo a media sesión: cambiar la regla
// para datos ya recolectados invalidaría la medición.
campaignsRouter.patch("/:id/jolting", requireAdmin, async (req, res) => {
  const probability = Number(req.body?.probability);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    return res.status(400).json({ error: "probability debe ser un número entre 0 y 1" });
  }
  const r = await query(`UPDATE campaigns SET jolting_probability = $1 WHERE id = $2 RETURNING *`, [probability, req.params.id]);
  if (r.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  res.json({ campaign: r.rows[0] });
});

// Migración 007, MODO SOMBRA (TG §8.2.5 -- motor de decisión con umbral de
// riesgo): a partir de qué puntaje [0,1] del modelo temporal el motor
// HABRÍA mostrado la intervención (deliveries.risk_would_trigger). Todavía
// NO gatea la intervención real -- eso sigue dependiendo solo de
// jolting_roll (ver joltingEligible en tracking.js) mientras el modelo se
// entrene con etiquetas sintéticas. Igual que jolting_probability, cambiar
// esto no recalcula deliveries ya puntuados: cada uno guarda el umbral que
// estaba vigente cuando se calculó su risk_score.
campaignsRouter.patch("/:id/risk-threshold", requireAdmin, async (req, res) => {
  const threshold = Number(req.body?.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    return res.status(400).json({ error: "threshold debe ser un número entre 0 y 1" });
  }
  const r = await query(`UPDATE campaigns SET risk_threshold = $1 WHERE id = $2 RETURNING *`, [threshold, req.params.id]);
  if (r.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  res.json({ campaign: r.rows[0] });
});

// Genera un enlace de un solo uso por participante (sin estímulo todavía:
// el estímulo se envía después como un "mensaje" desde la pestaña Mensajes).
campaignsRouter.post("/:id/generate-tokens", requireAdmin, async (req, res) => {
  const campaignId = req.params.id;
  const { participant_ids } = req.body ?? {};
  const c = await query(`SELECT id FROM campaigns WHERE id = $1`, [campaignId]);
  if (c.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });

  const where = Array.isArray(participant_ids) && participant_ids.length > 0
    ? { sql: "p.id = ANY($2::uuid[])", args: [campaignId, participant_ids] }
    : { sql: "TRUE", args: [campaignId] };

  const participants = await query(
    `SELECT p.id FROM participants p
     WHERE ${where.sql}
       AND NOT EXISTS (SELECT 1 FROM participant_campaign pc WHERE pc.participant_id = p.id AND pc.campaign_id = $1)
     ORDER BY p.id`,
    where.args
  );

  const created = [];
  for (const row of participants.rows) {
    const r = await query(
      `INSERT INTO participant_campaign (participant_id, campaign_id, access_token)
       VALUES ($1, $2, $3) ON CONFLICT (participant_id, campaign_id) DO NOTHING
       RETURNING id, participant_id, access_token`,
      [row.id, campaignId, generateAccessToken()]
    );
    if (r.rows[0]) created.push(r.rows[0]);
  }
  res.status(201).json({ generated: created.length, links: created.map((x) => ({ participant_id: x.participant_id, url: `/t/${x.access_token}` })) });
});

// Asignación balanceada y reproducible de group_assignment (control/
// experimental) — TG §9.2. Hoy el grupo se fija a mano al importar
// participantes (uno por uno o por CSV); este endpoint reutiliza el mismo
// mecanismo que ya reparte el vector de ataque por equipo (`assignBalanced`,
// lib/rng.js) para repartir el grupo, evitando: (a) sesgo — todo el mundo con
// el mismo criterio manual termina en el mismo grupo — y (b) que dos personas
// corran esto y obtengan repartos distintos para la misma campaña.
//
// group_assignment vive en `participants` (no en `participant_campaign`):
// es un atributo de la persona, no de su paso por esta campaña en concreto.
// Por eso este endpoint es deliberadamente conservador en dos sentidos:
//  1. Por defecto SOLO asigna a quienes tienen group_assignment NULL — no
//     pisa un grupo puesto a mano (import CSV/JSON), salvo que se pida
//     force:true explícitamente.
//  2. Nunca reasigna a alguien cuya sesión en ESTA campaña ya empezó
//     (`participant_campaign.session_started_at`), ni con force:true —
//     cambiarle el grupo a mitad o después de la prueba invalidaría los
//     datos ya recolectados (p.ej. si ya vio o no la intervención jolting).
//
// Concurrencia: todo el "leer quiénes son elegibles -> calcular el reparto
// -> escribirlo" corre dentro de UNA transacción, con un advisory lock de
// Postgres tomado sobre esta campaña como primer paso (`pg_advisory_xact_
// lock`). Si dos llamadas llegan casi al mismo tiempo para la MISMA
// campaña, la segunda queda esperando en ese lock hasta que la primera
// termine (COMMIT o ROLLBACK) — así nunca leen el mismo conjunto de
// "elegibles" antes de que el otro escriba, que era exactamente el riesgo
// documentado en la entrega anterior (dos repartos mezclándose y perdiendo
// la garantía de balance). El lock es "xact" (de transacción): Postgres lo
// suelta solo al terminar, sin que el código tenga que acordarse de
// liberarlo ni riesgo de dejarlo pegado si algo falla a mitad de camino.
// Campañas DISTINTAS (distinto id -> distinto hash) nunca se bloquean entre
// sí, así que esto no afecta el caso normal de un solo investigador.
campaignsRouter.post("/:id/assign-groups", requireAdmin, async (req, res) => {
  const campaignId = req.params.id;
  const force = req.body?.force === true;

  const result = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [campaignId]);

    const c = await client.query(`SELECT seed FROM campaigns WHERE id = $1`, [campaignId]);
    if (c.rows.length === 0) return { notFound: true };

    const rows = await client.query(
      `SELECT p.id AS participant_id, p.group_assignment, pc.session_started_at
       FROM participant_campaign pc JOIN participants p ON p.id = pc.participant_id
       WHERE pc.campaign_id = $1
       ORDER BY p.id`,
      [campaignId]
    );

    const bloqueados = rows.rows.filter((r) => r.session_started_at !== null);
    const disponibles = rows.rows.filter((r) => r.session_started_at === null);
    const elegibles = disponibles.filter((r) => force || r.group_assignment === null);
    const yaAsignados = disponibles.length - elegibles.length;

    let resumen = { control: 0, experimental: 0 };
    if (elegibles.length > 0) {
      const assigned = assignBalanced(["control", "experimental"], elegibles.length, `${c.rows[0].seed}:${campaignId}:group`);
      for (let i = 0; i < elegibles.length; i++) {
        await client.query(`UPDATE participants SET group_assignment = $1 WHERE id = $2`, [assigned[i], elegibles[i].participant_id]);
        resumen[assigned[i]]++;
      }
    }

    return {
      asignados: elegibles.length,
      resumen,
      omitidos_ya_asignados: yaAsignados,
      omitidos_por_sesion_iniciada: bloqueados.length,
    };
  });

  if (result.notFound) return res.status(404).json({ error: "Campaña no encontrada" });
  res.json(result);
});

// Equipos de la campaña (para elegir destinatarios al enviar un mensaje).
campaignsRouter.get("/:id/teams", requireAdmin, async (req, res) => {
  const r = await query(
    `SELECT COALESCE(p.team_label, '(sin equipo)') AS team_label, COUNT(*) AS participantes
     FROM participant_campaign pc JOIN participants p ON p.id = pc.participant_id
     WHERE pc.campaign_id = $1
     GROUP BY p.team_label ORDER BY p.team_label`,
    [req.params.id]
  );
  res.json({ teams: r.rows });
});

// Qué se ha enviado a cada equipo de la campaña: técnicas de ataque (vector) y
// número de mensajes benignos. Alimenta la "verificación previa" del panel y el
// aviso de "una técnica por equipo".
campaignsRouter.get("/:id/coverage", requireAdmin, async (req, res) => {
  const teams = await query(
    `SELECT COALESCE(p.team_label, '(sin equipo)') AS team_label,
            COUNT(DISTINCT pc.id) AS participantes
     FROM participant_campaign pc JOIN participants p ON p.id = pc.participant_id
     WHERE pc.campaign_id = $1
     GROUP BY p.team_label ORDER BY p.team_label`,
    [req.params.id]
  );
  const sent = await query(
    `SELECT COALESCE(p.team_label, '(sin equipo)') AS team_label,
            m.id AS message_id, m.subject, m.is_attack, m.vector,
            COUNT(DISTINCT d.id) AS enviados
     FROM deliveries d
     JOIN messages m ON m.id = d.message_id
     JOIN participant_campaign pc ON pc.id = d.participant_campaign_id
     JOIN participants p ON p.id = pc.participant_id
     WHERE m.campaign_id = $1
     GROUP BY p.team_label, m.id, m.subject, m.is_attack, m.vector
     ORDER BY p.team_label`,
    [req.params.id]
  );
  const byTeam = new Map(
    teams.rows.map((t) => [t.team_label, {
      team_label: t.team_label, participantes: Number(t.participantes),
      ataques: [], benignos: 0,
    }])
  );
  for (const r of sent.rows) {
    const entry = byTeam.get(r.team_label) || { team_label: r.team_label, participantes: 0, ataques: [], benignos: 0 };
    if (r.is_attack) entry.ataques.push({ vector: r.vector, message_id: r.message_id, subject: r.subject, enviados: Number(r.enviados) });
    else entry.benignos += Number(r.enviados);
    byTeam.set(r.team_label, entry);
  }
  res.json({ teams: [...byTeam.values()] });
});

// Sugerencia reproducible de qué vector asignar a cada equipo (balanceado por
// la semilla de la campaña). El admin decide si la sigue.
campaignsRouter.get("/:id/plan", requireAdmin, async (req, res) => {
  const c = await query(`SELECT seed FROM campaigns WHERE id = $1`, [req.params.id]);
  if (c.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  const teams = await query(
    `SELECT DISTINCT COALESCE(p.team_label, '(sin equipo)') AS team_label
     FROM participant_campaign pc JOIN participants p ON p.id = pc.participant_id
     WHERE pc.campaign_id = $1 ORDER BY 1`,
    [req.params.id]
  );
  const pool = await query(
    `SELECT t.vector FROM campaign_templates ct JOIN templates t ON t.id = ct.template_id
     WHERE ct.campaign_id = $1`,
    [req.params.id]
  );
  const vectors = [...new Set(pool.rows.map((r) => r.vector))];
  if (vectors.length === 0) return res.json({ plan: [], note: "La campaña no tiene plantillas en el pool." });
  const assigned = assignBalanced(vectors, teams.rows.length, `${c.rows[0].seed}:${req.params.id}`);
  res.json({ plan: teams.rows.map((t, i) => ({ team_label: t.team_label, vector: assigned[i] })) });
});

campaignsRouter.get("/:id/links", requireAdmin, async (req, res) => {
  const r = await query(
    `SELECT pc.id, pc.access_token, pc.session_started_at, pc.finished_at,
            p.external_hash, p.role, p.team_label, p.group_assignment,
            (SELECT COUNT(*) FROM deliveries d WHERE d.participant_campaign_id = pc.id) AS mensajes,
            EXISTS (SELECT 1 FROM post_session_survey s WHERE s.participant_campaign_id = pc.id) AS encuesta
     FROM participant_campaign pc JOIN participants p ON p.id = pc.participant_id
     WHERE pc.campaign_id = $1 ORDER BY p.team_label, p.external_hash`,
    [req.params.id]
  );
  res.json({ links: r.rows.map((x) => ({ ...x, url: `/t/${x.access_token}` })) });
});

// Borra el hilo de chat (lib/chat.js) de uno o más participantes, junto con
// los "mensajes de ataque por chat" que ese hilo haya generado (uno propio
// por participante, ver instantiateScript en lib/chat.js -- no son la fila
// compartida de la biblioteca de plantillas, así que borrarlos es seguro).
//
// Por qué existe esto: un chat_thread se instancia UNA SOLA VEZ, la primera
// vez que el participante abre la vista de chat (getOrCreateThread). Si en
// ese momento la campaña todavía no tenía guion (o tenía uno distinto), el
// hilo queda vacío/desactualizado PARA SIEMPRE -- crear o editar un guion
// después nunca lo vuelve a tocar. Se descubrió en el uso real: un admin
// cargó participantes, los probó (esto creó hilos vacíos), y recién después
// armó el guion de chat -- el guion se guardaba bien en la base, pero jamás
// aparecía al volver a entrar al chat porque el hilo ya existía. Para que
// "Reiniciar" sirva de verdad para volver a probar tras cambiar algo en el
// paso 6, tiene que incluir esto -- si no, sigue viéndose "roto" aunque el
// guion esté perfectamente guardado.
async function resetChatThreads(pcIds) {
  if (pcIds.length === 0) return;
  await query(
    `DELETE FROM messages WHERE id IN (
       SELECT d.message_id FROM chat_messages cm
       JOIN chat_threads ct ON ct.id = cm.chat_thread_id
       JOIN deliveries d ON d.id = cm.delivery_id
       WHERE ct.participant_campaign_id = ANY($1::uuid[]) AND cm.kind = 'attack'
     )`,
    [pcIds]
  );
  await query(`DELETE FROM chat_threads WHERE participant_campaign_id = ANY($1::uuid[])`, [pcIds]);
}

// Reinicia TODA la campaña para pruebas: borra eventos, encuestas y estado de
// sesión, y deja los mensajes ya enviados como "recién llegados" (sin abrir).
// Conserva participantes, enlaces y mensajes: el participante puede repetir
// la prueba con la misma bandeja. También borra los hilos de chat (ver
// resetChatThreads arriba) para que, si cambiaste algo en Interacción · paso
// 6 después de la primera prueba, la próxima vez que el participante abra el
// chat sí refleje el guion/contactos actuales.
campaignsRouter.post("/:id/reset", requireAdmin, async (req, res) => {
  const ids = await query(`SELECT id FROM participant_campaign WHERE campaign_id = $1`, [req.params.id]);
  const pcIds = ids.rows.map((r) => r.id);
  if (pcIds.length === 0) return res.json({ reset: 0 });
  await query(`DELETE FROM events WHERE participant_campaign_id = ANY($1::uuid[])`, [pcIds]);
  await query(`DELETE FROM post_session_survey WHERE participant_campaign_id = ANY($1::uuid[])`, [pcIds]);
  await resetChatThreads(pcIds);
  await query(`UPDATE deliveries SET delivered_at = now() WHERE participant_campaign_id = ANY($1::uuid[])`, [pcIds]);
  await query(`INSERT INTO events (participant_campaign_id, delivery_id, event_type)
               SELECT d.participant_campaign_id, d.id, 'entregado' FROM deliveries d WHERE d.participant_campaign_id = ANY($1::uuid[])`, [pcIds]);
  await query(`UPDATE participant_campaign SET session_started_at = NULL, finished_at = NULL, usability_interactions = 0, calibration_started_at = NULL, calibration_completed_at = NULL WHERE id = ANY($1::uuid[])`, [pcIds]);
  await query(`UPDATE participants SET consent_given = FALSE, consent_timestamp = NULL, camera_consent_given = FALSE, camera_consent_timestamp = NULL WHERE id IN (SELECT participant_id FROM participant_campaign WHERE campaign_id = $1)`, [req.params.id]);
  res.json({ reset: pcIds.length });
});

// Reinicia un solo participante (mismo alcance que arriba, pero para uno).
// Conserva los mensajes ya enviados y los deja sin abrir.
campaignsRouter.post("/:id/participants/:pcId/reset", requireAdmin, async (req, res) => {
  const pc = await query(`SELECT id, participant_id FROM participant_campaign WHERE id = $1 AND campaign_id = $2`, [req.params.pcId, req.params.id]);
  if (pc.rows.length === 0) return res.status(404).json({ error: "Participante no encontrado en la campaña" });
  await query(`DELETE FROM events WHERE participant_campaign_id = $1`, [req.params.pcId]);
  await query(`DELETE FROM post_session_survey WHERE participant_campaign_id = $1`, [req.params.pcId]);
  await resetChatThreads([req.params.pcId]);
  await query(`UPDATE deliveries SET delivered_at = now() WHERE participant_campaign_id = $1`, [req.params.pcId]);
  await query(`INSERT INTO events (participant_campaign_id, delivery_id, event_type)
               SELECT d.participant_campaign_id, d.id, 'entregado' FROM deliveries d WHERE d.participant_campaign_id = $1`, [req.params.pcId]);
  await query(`UPDATE participant_campaign SET session_started_at = NULL, finished_at = NULL, usability_interactions = 0, calibration_started_at = NULL, calibration_completed_at = NULL WHERE id = $1`, [req.params.pcId]);
  await query(`UPDATE participants SET consent_given = FALSE, consent_timestamp = NULL, camera_consent_given = FALSE, camera_consent_timestamp = NULL WHERE id = $1`, [pc.rows[0].participant_id]);
  res.json({ reset: 1 });
});
