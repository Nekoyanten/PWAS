// Retiro de datos post-sesión (TG §9.1, hallazgo 4.2 del informe de revisión
// crítica del 12 de septiembre de 2026): antes de este flujo, "revocable en
// cualquier momento sin consecuencia alguna" solo era cierto DURANTE la
// sesión (dejar de marcar la casilla de consentimiento) — no existía ninguna
// forma de ejercerlo después de que la sesión ya había terminado. Ver
// apps/api/src/lib/withdrawal.js y docs/2026-09-12_retiro-de-datos-post-sesion.md.
//
// Verifica que:
//  - GET /:token/withdraw muestra una pantalla de confirmación (no borra
//    nada solo con abrir el enlace);
//  - POST /:token/withdraw borra en cascada TODO lo de la sesión: eventos de
//    mouse/teclado (behavior_sessions/events), señales faciales
//    (facial_sessions/events), encuesta post-sesión, tableros
//    (boards/board_columns/board_tasks), el hilo de chat
//    (chat_threads/chat_messages), y los deliveries/events de mensajes;
//  - la fila de participants queda huérfana se borra también (si esa era su
//    única campaña);
//  - el enlace deja de funcionar después (token inválido en cualquier ruta);
//  - pedir el retiro dos veces no rompe nada (la segunda vez es 404, no 500);
//  - si el mismo participante (mismo participant_id) tiene OTRA campaña
//    activa, la fila de participants NO se borra al retirarse de esta.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import { cleanupTestData } from "../helpers/cleanup.js";
import * as boards from "../../src/lib/boards.js";
import * as chat from "../../src/lib/chat.js";

process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "test_key_local_only";

let server, baseUrl;
const jh = { "x-api-key": process.env.ADMIN_API_KEY, "Content-Type": "application/json" };

before(() => { server = createApp().listen(0); baseUrl = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await cleanupTestData(); await pool.end(); });

const api = async (method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: jh, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const hop = (path, opts) => fetch(`${baseUrl}${path}`, { redirect: "manual", ...opts });
const form = (path, data) => hop(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: data });
const completeCalibration = (token) => hop(`/t/${token}/calibration/complete`, { method: "POST" });

// Crea campaña + un participante, consiente (con cámara) y completa la
// calibración — deja al participante listo para "usar" la app y generar
// datos de sesión reales antes de pedir el retiro.
async function setupParticipant(stamp, { externalHash } = {}) {
  const c = await api("POST", "/api/campaigns", { name: `Retiro ${stamp}` });
  const campaignId = c.body.campaign.id;
  const team = `RetiroTeam ${stamp}`;
  const extHash = externalHash || `retiro_${stamp}`;
  await api("POST", "/api/participants/import", {
    participants: [{ external_hash: extHash, role: "estudiante", team_label: team }],
  });
  await api("POST", `/api/campaigns/${campaignId}/generate-tokens`, {});
  const token = (await pool.query(
    `SELECT access_token FROM participant_campaign pc JOIN participants p ON p.id = pc.participant_id WHERE p.external_hash = $1 AND pc.campaign_id = $2`,
    [extHash, campaignId]
  )).rows[0].access_token;
  const row = (await pool.query(
    `SELECT pc.id AS pc_id, pc.participant_id FROM participant_campaign pc WHERE pc.access_token = $1`,
    [token]
  )).rows[0];
  await form(`/t/${token}/consent`, "consent=1&camera_consent=1");
  await completeCalibration(token);
  return { token, campaignId, pcId: row.pc_id, participantId: row.participant_id, extHash };
}

function uuid() {
  return "10000000-0000-4000-8000-".concat(String(Math.floor(Math.random() * 1e12)).padStart(12, "0"));
}

// Puebla behavior_sessions/events, facial_sessions/events, post_session_survey,
// boards/board_columns/board_tasks, chat_threads/chat_messages y un
// delivery+event de un mensaje real -- así el retiro se verifica contra datos
// de verdad en cada tabla que dice cubrir, no solo contra la fila "cabecera"
// de participant_campaign.
async function populateSessionData(pc) {
  const behaviorSessionId = uuid();
  await hop(`/t/${pc.token}/behavior`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: behaviorSessionId, phase: "app", viewport_w: 1280, viewport_h: 800,
      samples: [{ t: 10, type: "mousemove", x: 100, y: 200 }, { t: 20, type: "keydown", code: "KeyA" }],
    }),
  });

  const facialSessionId = uuid();
  await hop(`/t/${pc.token}/facial`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: facialSessionId, phase: "app", camera_w: 640, camera_h: 480,
      samples: [{ t: 15, fd: true, eo: 0.8, bl: false, gx: 0.1, gy: -0.1, bt: 0.2, mt: 0.1 }],
    }),
  });

  await form(`/t/${pc.token}/survey`, "fell_for_attack=false&fall_reason=no_aplica");

  const board = await boards.createBoard(pc.pcId, { name: "Mi tablero" });
  const colRow = await pool.query(`SELECT id FROM board_columns WHERE board_id = $1 ORDER BY position LIMIT 1`, [board.id]);
  await boards.createTask(colRow.rows[0].id, { title: "Tarea de prueba", description: null, responsible_contact_id: null, priority: "media", checklist: [] });

  const { thread } = await chat.getOrCreateThread({ id: pc.pcId, campaign_id: pc.campaignId });
  await chat.appendReply(thread.id, "hola equipo");

  const msg = await pool.query(
    `INSERT INTO messages (campaign_id, kind, is_attack, subject) VALUES ($1, 'email', FALSE, 'Asunto de prueba') RETURNING id`,
    [pc.campaignId]
  );
  const delivery = await pool.query(
    `INSERT INTO deliveries (message_id, participant_campaign_id) VALUES ($1, $2) RETURNING id`,
    [msg.rows[0].id, pc.pcId]
  );
  await pool.query(
    `INSERT INTO events (participant_campaign_id, delivery_id, event_type) VALUES ($1, $2, 'entregado')`,
    [pc.pcId, delivery.rows[0].id]
  );

  return { behaviorSessionId, facialSessionId, boardId: board.id, columnId: colRow.rows[0].id, threadId: thread.id, messageId: msg.rows[0].id, deliveryId: delivery.rows[0].id };
}

async function countsFor(pcId, data) {
  const q = (sql, params) => pool.query(sql, params).then((r) => Number(r.rows[0].n));
  return {
    behaviorSessions: await q(`SELECT count(*)::int AS n FROM behavior_sessions WHERE id = $1`, [data.behaviorSessionId]),
    behaviorEvents: await q(`SELECT count(*)::int AS n FROM behavior_events WHERE behavior_session_id = $1`, [data.behaviorSessionId]),
    facialSessions: await q(`SELECT count(*)::int AS n FROM facial_sessions WHERE id = $1`, [data.facialSessionId]),
    facialEvents: await q(`SELECT count(*)::int AS n FROM facial_events WHERE facial_session_id = $1`, [data.facialSessionId]),
    survey: await q(`SELECT count(*)::int AS n FROM post_session_survey WHERE participant_campaign_id = $1`, [pcId]),
    boards: await q(`SELECT count(*)::int AS n FROM boards WHERE id = $1`, [data.boardId]),
    boardColumns: await q(`SELECT count(*)::int AS n FROM board_columns WHERE id = $1`, [data.columnId]),
    boardTasks: await q(`SELECT count(*)::int AS n FROM board_tasks WHERE column_id = $1`, [data.columnId]),
    chatThreads: await q(`SELECT count(*)::int AS n FROM chat_threads WHERE id = $1`, [data.threadId]),
    chatMessages: await q(`SELECT count(*)::int AS n FROM chat_messages WHERE chat_thread_id = $1`, [data.threadId]),
    deliveries: await q(`SELECT count(*)::int AS n FROM deliveries WHERE id = $1`, [data.deliveryId]),
    events: await q(`SELECT count(*)::int AS n FROM events WHERE delivery_id = $1`, [data.deliveryId]),
    participantCampaign: await q(`SELECT count(*)::int AS n FROM participant_campaign WHERE id = $1`, [pcId]),
  };
}

test("GET /:token/withdraw muestra confirmación y NO borra nada todavía", async () => {
  const pc = await setupParticipant(Date.now());
  const data = await populateSessionData(pc);

  const res = await hop(`/t/${pc.token}/withdraw`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Retirar mis datos/);
  assert.match(html, /No se puede deshacer/);

  const before = await countsFor(pc.pcId, data);
  assert.equal(before.participantCampaign, 1, "nada se borró solo por hacer GET");
  assert.equal(before.behaviorEvents, 2);
  assert.equal(before.facialEvents, 1);
});

test("POST /:token/withdraw borra en cascada toda la sesión y la fila de participants huérfana", async () => {
  const stamp = Date.now();
  const pc = await setupParticipant(stamp);
  const data = await populateSessionData(pc);

  const before = await countsFor(pc.pcId, data);
  assert.deepEqual(before, {
    behaviorSessions: 1, behaviorEvents: 2, facialSessions: 1, facialEvents: 1,
    survey: 1, boards: 1, boardColumns: 1, boardTasks: 1,
    chatThreads: 1, chatMessages: 1, deliveries: 1, events: 1, participantCampaign: 1,
  }, "los datos de sesión quedaron poblados antes de pedir el retiro");

  const res = await hop(`/t/${pc.token}/withdraw`, { method: "POST" });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Tus datos fueron retirados/);

  const after = await countsFor(pc.pcId, data);
  for (const [key, n] of Object.entries(after)) {
    assert.equal(n, 0, `${key} debería quedar en 0 tras el retiro`);
  }

  const participantRow = await pool.query(`SELECT 1 FROM participants WHERE id = $1`, [pc.participantId]);
  assert.equal(participantRow.rows.length, 0, "la fila de participants huérfana también se borra");
});

test("el enlace deja de funcionar después del retiro, y pedirlo dos veces no rompe nada", async () => {
  const pc = await setupParticipant(Date.now());
  await populateSessionData(pc);

  const first = await hop(`/t/${pc.token}/withdraw`, { method: "POST" });
  assert.equal(first.status, 200);

  const appAfter = await hop(`/t/${pc.token}/app`);
  assert.equal(appAfter.status, 404, "el token ya no resuelve a ningún participante");

  const confirmAfter = await hop(`/t/${pc.token}/withdraw`);
  assert.equal(confirmAfter.status, 404, "reabrir la confirmación con el mismo token da 404, no error");

  const second = await hop(`/t/${pc.token}/withdraw`, { method: "POST" });
  assert.equal(second.status, 404, "pedir el retiro dos veces es 404 la segunda vez, no 500");
});

test("si el participante tiene OTRA campaña, retirarse de una no borra su fila de participants", async () => {
  const stamp = Date.now();
  const extHash = `retiro_multi_${stamp}`;
  const pcA = await setupParticipant(stamp, { externalHash: extHash });
  const dataA = await populateSessionData(pcA);

  // Segunda campaña, mismo external_hash -> mismo participant_id.
  const c2 = await api("POST", "/api/campaigns", { name: `Retiro B ${stamp}` });
  const campaignId2 = c2.body.campaign.id;
  await api("POST", "/api/participants/import", {
    participants: [{ external_hash: extHash, role: "estudiante", team_label: `RetiroTeam ${stamp}` }],
  });
  await api("POST", `/api/campaigns/${campaignId2}/generate-tokens`, {});
  const pcRowB = (await pool.query(
    `SELECT pc.id AS pc_id, pc.access_token FROM participant_campaign pc
     JOIN participants p ON p.id = pc.participant_id
     WHERE p.external_hash = $1 AND pc.campaign_id = $2`,
    [extHash, campaignId2]
  )).rows[0];

  const res = await hop(`/t/${pcA.token}/withdraw`, { method: "POST" });
  assert.equal(res.status, 200);

  const afterA = await countsFor(pcA.pcId, dataA);
  assert.equal(afterA.participantCampaign, 0, "la campaña A sí se borró");

  const participantRow = await pool.query(`SELECT 1 FROM participants WHERE id = $1`, [pcA.participantId]);
  assert.equal(participantRow.rows.length, 1, "participants NO se borra: todavía tiene la campaña B");

  const pcbRow = await pool.query(`SELECT 1 FROM participant_campaign WHERE id = $1`, [pcRowB.pc_id]);
  assert.equal(pcbRow.rows.length, 1, "la campaña B del mismo participante sigue intacta");
});
