// Prueba de integración del etiquetado fino (TG §8.2.1 Tabla 1, módulo 7,
// migración 008) -- contra Postgres real.
//
// Contexto: hasta ahora `behavior_events` guardaba solo la captura CRUDA
// (una fila por muestra de mouse/teclado). Este módulo agrega
// `behavior_session_features`, una fila por SESIÓN con las features
// REALES ya calculadas (AUC/SE/MD, latencias de tecleo, z-scores contra la
// línea base de calibración) -- el mismo conjunto que ya entrena los
// baselines tabulares del pipeline de Python (ml/src/dataset.py), pero
// persistido en esta base de datos para que el dashboard/exportación no
// dependan de correr Python cada vez.
//
// Verifica que:
//  - POST /api/dashboard/recompute-features calcula y guarda una fila por
//    sesión con captura conductual, sin tocar sesiones sin eventos;
//  - un participante CON sesión de calibración usa línea base PERSONAL para
//    sus otras sesiones; uno SIN calibración cae a la POBLACIONAL;
//  - recalcular dos veces actualiza la misma fila (upsert), no duplica;
//  - GET /api/dashboard/features-summary agrega por fase sin exponer una
//    fila por participante;
//  - GET /api/export/session-features.csv trae una fila por sesión con las
//    columnas esperadas, sin external_hash.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import { cleanupTestData } from "../helpers/cleanup.js";

process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "test_key_local_only";

let server, baseUrl;
const key = process.env.ADMIN_API_KEY;
const jh = { "x-api-key": key, "Content-Type": "application/json" };

before(() => { server = createApp().listen(0); baseUrl = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await cleanupTestData(); await pool.end(); });

const api = async (method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: jh, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const hop = (path, opts = {}) => fetch(`${baseUrl}${path}`, { redirect: "manual", ...opts });
const form = (path, data) => hop(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: data });
const completeCalibration = (token) => hop(`/t/${token}/calibration/complete`, { method: "POST" });
const postBehavior = (token, payload) => fetch(`${baseUrl}/t/${token}/behavior`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
});

// Campaña + un ataque enviado a UN participante, ya consentido y calibrado
// (administrativamente -- ver comentario abajo sobre por qué la captura de
// calibración se postea aparte). Mismo patrón que las demás suites.
async function setupParticipant(stamp) {
  const t = await api("POST", "/api/templates", {
    name: `Feat ${stamp}`, vector: "urgencia", kind: "email", is_attack: true,
    sender_label: "Seguridad", subject_or_headline: "Verifica tu cuenta", message_body: "<p>Haz clic ya.</p>",
    cta_label: "Verificar", landing_kind: "form",
  });
  const c = await api("POST", "/api/campaigns", { name: `CampFeat ${stamp}` });
  const campaignId = c.body.campaign.id;
  const team = `EquipoFeat ${stamp}`;
  const imp = await api("POST", "/api/participants/import", {
    participants: [{ external_hash: `feat_${stamp}`, role: "estudiante", team_label: team, group_assignment: "control" }],
  });
  const participantId = imp.body.participants[0].id;
  await api("POST", `/api/campaigns/${campaignId}/generate-tokens`, { participant_ids: [participantId] });
  const msg = await api("POST", `/api/campaigns/${campaignId}/messages`, { template_id: t.body.template.id, kind: "email" });
  const messageId = msg.body.message.id;
  const send = await api("POST", `/api/messages/${messageId}/send`, { team_labels: [team] });
  assert.equal(send.body.delivered, 1);

  const token = (await pool.query(
    `SELECT access_token FROM participant_campaign pc JOIN participants p ON p.id = pc.participant_id WHERE p.external_hash = $1`,
    [`feat_${stamp}`]
  )).rows[0].access_token;
  await form(`/t/${token}/consent`, "consent=1");
  // Marca la calibración como administrativamente completada (paso
  // obligatorio del protocolo, TG §9.5) -- independiente de si se posteó o
  // no captura conductual REAL para esa fase, que es lo que de verdad
  // determina si hay línea base personal (ver más abajo).
  await completeCalibration(token);
  const deliveryId = (await (await hop(`/t/${token}/app`)).text()).match(/\/d\/([0-9a-f-]{36})/)[1];
  const pcId = (await pool.query(
    `SELECT pc.id FROM participant_campaign pc JOIN participants p ON p.id = pc.participant_id WHERE p.external_hash = $1`,
    [`feat_${stamp}`]
  )).rows[0].id;
  return { campaignId, messageId, token, deliveryId, pcId };
}

// Trayectoria de mouse con jitter + un par de teclas -- suficiente para que
// mouse_trajectory_features/keystroke_features tengan algo no trivial que
// medir (no solo 0-1 puntos).
function behaviorPayload({ sessionId, phase, deliveryId = null, offsetX = 100 }) {
  const samples = [];
  let t = 0;
  for (let i = 0; i < 12; i++) {
    t += 35 + (i % 3) * 5;
    samples.push({ t, type: "mousemove", x: offsetX + i * 12, y: 200 + (i % 4) * 7 });
  }
  samples.push({ t: t + 40, type: "keydown", code: "KeyA" });
  samples.push({ t: t + 90, type: "keyup", code: "KeyA" });
  return { session_id: sessionId, phase, delivery_id: deliveryId, viewport_w: 1920, viewport_h: 945, samples };
}

/* ------------------------- recompute-features: básico ------------------------- */

test("POST recompute-features: calcula y guarda una fila por sesión con captura conductual", async () => {
  const stamp = Date.now();
  const { deliveryId, pcId } = await setupParticipant(stamp);
  const sessionId = crypto.randomUUID();
  const res = await postBehavior((await pool.query(
    `SELECT access_token FROM participant_campaign WHERE id = $1`, [pcId]
  )).rows[0].access_token, behaviorPayload({ sessionId, phase: "message", deliveryId }));
  assert.equal(res.status, 204);

  const r = await api("POST", "/api/dashboard/recompute-features", {});
  assert.equal(r.status, 200);
  assert.ok(r.body.computed >= 1);

  const row = (await pool.query(`SELECT * FROM behavior_session_features WHERE session_id = $1`, [sessionId])).rows[0];
  assert.ok(row, "debe existir una fila para la sesión con captura");
  assert.equal(row.phase, "message");
  assert.equal(row.participant_campaign_id, pcId);
  assert.ok(row.mouse_n_points >= 2);
  assert.ok(Number(row.key_n_keys) === 1);
  assert.ok(row.feature_version, "debe quedar registrada la versión del código de cálculo");
  assert.ok(row.computed_at);
});

/* ------------------- línea base personal vs. poblacional ------------------- */

test("línea base PERSONAL: un participante con sesión de calibración la usa para sus otras sesiones", async () => {
  const stamp = Date.now() + 1;
  const { token, deliveryId, pcId } = await setupParticipant(stamp);

  const calibSession = crypto.randomUUID();
  const msgSession = crypto.randomUUID();
  await postBehavior(token, behaviorPayload({ sessionId: calibSession, phase: "calibration", offsetX: 50 }));
  await postBehavior(token, behaviorPayload({ sessionId: msgSession, phase: "message", deliveryId, offsetX: 300 }));

  const r = await api("POST", "/api/dashboard/recompute-features", { campaign_id: (await pool.query(
    `SELECT campaign_id FROM participant_campaign WHERE id = $1`, [pcId]
  )).rows[0].campaign_id });
  assert.equal(r.status, 200);
  assert.ok(r.body.computed >= 2);

  const calibRow = (await pool.query(`SELECT * FROM behavior_session_features WHERE session_id = $1`, [calibSession])).rows[0];
  const msgRow = (await pool.query(`SELECT * FROM behavior_session_features WHERE session_id = $1`, [msgSession])).rows[0];
  assert.equal(calibRow.baseline_z_source, "personal");
  assert.equal(msgRow.baseline_z_source, "personal", "el mensaje del MISMO participante debe usar su propia calibración");
});

test("línea base POBLACIONAL: un participante SIN sesión de calibración cae al respaldo poblacional", async () => {
  const stamp = Date.now() + 2;
  const { token, deliveryId, pcId } = await setupParticipant(stamp);
  const msgSession = crypto.randomUUID();
  // Solo fase 'message' -- sin ninguna sesión de fase 'calibration' para
  // este participante (aunque administrativamente ya "completó" ese paso).
  await postBehavior(token, behaviorPayload({ sessionId: msgSession, phase: "message", deliveryId, offsetX: 700 }));

  const campaignId = (await pool.query(`SELECT campaign_id FROM participant_campaign WHERE id = $1`, [pcId])).rows[0].campaign_id;
  const r = await api("POST", "/api/dashboard/recompute-features", { campaign_id: campaignId });
  assert.equal(r.status, 200);

  const row = (await pool.query(`SELECT * FROM behavior_session_features WHERE session_id = $1`, [msgSession])).rows[0];
  assert.equal(row.baseline_z_source, "poblacional");
});

/* ------------------------------ idempotencia ------------------------------ */

test("recalcular dos veces actualiza la MISMA fila (upsert), no la duplica", async () => {
  const stamp = Date.now() + 3;
  const { token, deliveryId, pcId } = await setupParticipant(stamp);
  const sessionId = crypto.randomUUID();
  await postBehavior(token, behaviorPayload({ sessionId, phase: "message", deliveryId }));
  const campaignId = (await pool.query(`SELECT campaign_id FROM participant_campaign WHERE id = $1`, [pcId])).rows[0].campaign_id;

  await api("POST", "/api/dashboard/recompute-features", { campaign_id: campaignId });
  const first = (await pool.query(`SELECT computed_at FROM behavior_session_features WHERE session_id = $1`, [sessionId])).rows[0];

  await new Promise((r) => setTimeout(r, 20));
  await api("POST", "/api/dashboard/recompute-features", { campaign_id: campaignId });
  const rows = await pool.query(`SELECT computed_at FROM behavior_session_features WHERE session_id = $1`, [sessionId]);
  assert.equal(rows.rows.length, 1, "no debe duplicar la fila");
  assert.ok(new Date(rows.rows[0].computed_at) >= new Date(first.computed_at), "computed_at debe avanzar en el recálculo");
});

/* ------------------------------ features-summary ------------------------------ */

test("GET features-summary agrega por fase, sin exponer una fila por participante", async () => {
  const stamp = Date.now() + 4;
  const { token, deliveryId, pcId } = await setupParticipant(stamp);
  const sessionId = crypto.randomUUID();
  await postBehavior(token, behaviorPayload({ sessionId, phase: "message", deliveryId }));
  const campaignId = (await pool.query(`SELECT campaign_id FROM participant_campaign WHERE id = $1`, [pcId])).rows[0].campaign_id;
  await api("POST", "/api/dashboard/recompute-features", { campaign_id: campaignId });

  const summary = await api("GET", `/api/dashboard/features-summary?campaign_id=${campaignId}`);
  assert.equal(summary.status, 200);
  const msgPhase = summary.body.por_fase.find((r) => r.phase === "message");
  assert.ok(msgPhase);
  assert.ok(msgPhase.con_features >= 1);
  assert.ok(msgPhase.sesiones_totales >= msgPhase.con_features);
  for (const row of summary.body.por_fase) {
    assert.ok(!("participant_campaign_id" in row) && !("external_hash" in row), "nunca una fila por participante");
  }
});

/* ------------------------------ export CSV ------------------------------ */

test("GET /api/export/session-features.csv trae una fila por sesión, sin external_hash", async () => {
  const stamp = Date.now() + 5;
  const { token, deliveryId, pcId } = await setupParticipant(stamp);
  const sessionId = crypto.randomUUID();
  await postBehavior(token, behaviorPayload({ sessionId, phase: "message", deliveryId }));
  const campaignId = (await pool.query(`SELECT campaign_id FROM participant_campaign WHERE id = $1`, [pcId])).rows[0].campaign_id;
  await api("POST", "/api/dashboard/recompute-features", { campaign_id: campaignId });

  const res = await fetch(`${baseUrl}/api/export/session-features.csv?campaign_id=${campaignId}`, { headers: { "x-api-key": key } });
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.match(csv, /session_id/);
  assert.match(csv, /mouse_auc/);
  assert.match(csv, /baseline_z_source/);
  assert.doesNotMatch(csv, /external_hash/i, "el export nunca debe exponer external_hash");
  assert.match(csv, new RegExp(sessionId));
});
