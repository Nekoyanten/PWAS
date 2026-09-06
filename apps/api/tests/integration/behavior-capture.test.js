// Prueba de integración de la captura conductual real (Tabla 1 §8.2.1,
// fila 1): POST /t/:token/behavior (lo que llama apps/api/public/js/
// behavior-capture.js desde el navegador) y GET /api/export/behavior-events
// (lo que consume después el pipeline de preprocesamiento/ML, aparte de este
// repo). Ver db/migrations/004_behavior_capture.sql para el porqué del
// esquema y tracking.js para el porqué de cada validación.
//
// Verifica que:
//  - un lote válido queda guardado tal cual: una fila en behavior_sessions,
//    una fila por muestra en behavior_events, y el contador sample_count
//    correcto;
//  - un segundo lote de la MISMA sesión acumula sample_count en vez de crear
//    otra sesión (ON CONFLICT DO UPDATE);
//  - un token vencido/inválido responde 204 sin romper la página del
//    participante (mismo criterio que /usability), en vez de 404/500;
//  - muestras individuales inválidas (tipo de evento no reconocido, t
//    fuera de rango) se descartan sin tumbar el resto del lote;
//  - un lote sin ninguna muestra válida, o que excede el máximo de muestras
//    por request, responde 400;
//  - x/y fuera del rango SMALLINT se clampean en vez de romper el INSERT;
//  - el export /api/export/behavior-events.json trae, por muestra, el rol/
//    grupo/equipo del participante y el vector/is_attack del mensaje cuando
//    la muestra pertenece a un delivery — identificando al participante por
//    participant_campaign_id, sin exponer external_hash.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import { cleanupTestData } from "../helpers/cleanup.js";

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
const form = (path, data) => fetch(`${baseUrl}${path}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: data });
const hop = (path, opts) => fetch(`${baseUrl}${path}`, { redirect: "manual", ...opts });
const postBehavior = (token, payload) => fetch(`${baseUrl}/t/${token}/behavior`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
});

// Crea campaña + un participante consentido, y le entrega un ataque, tal
// como hacen las demás suites de integración. Devuelve token/deliveryId
// para poder atar sesiones de captura a un delivery concreto.
async function setupParticipant(stamp, extra = {}) {
  const c = await api("POST", "/api/campaigns", { name: `Beh ${stamp}` });
  const campaignId = c.body.campaign.id;
  const team = `BehTeam ${stamp}`;
  await api("POST", "/api/participants/import", {
    participants: [{ external_hash: `beh_${stamp}`, role: "estudiante", team_label: team, ...extra }],
  });
  await api("POST", `/api/campaigns/${campaignId}/generate-tokens`, {});
  const m = await api("POST", `/api/campaigns/${campaignId}/messages`, {
    is_attack: true, vector: "curiosidad", kind: "email", subject: `beh atk ${stamp}`, landing_kind: "form",
  });
  await api("POST", `/api/messages/${m.body.message.id}/send`, { team_labels: [team] });

  const token = (await pool.query(
    `SELECT access_token FROM participant_campaign pc JOIN participants p ON p.id = pc.participant_id WHERE p.external_hash = $1`,
    [`beh_${stamp}`]
  )).rows[0].access_token;
  await form(`/t/${token}/consent`, "consent=1");
  const deliveryId = (await (await hop(`/t/${token}/app`)).text()).match(/\/d\/([0-9a-f-]{36})/)[1];
  return { token, campaignId, deliveryId };
}

test("lote válido: crea la sesión y sus muestras, con sample_count correcto", async () => {
  const stamp = Date.now();
  const { token, deliveryId } = await setupParticipant(stamp);
  const sessionId = crypto.randomUUID();

  const res = await postBehavior(token, {
    session_id: sessionId, phase: "message", delivery_id: deliveryId,
    viewport_w: 1280, viewport_h: 800,
    samples: [
      { t: 0, type: "mousemove", x: 10, y: 20 },
      { t: 40, type: "mousemove", x: 12, y: 22 },
      { t: 120, type: "keydown", code: "KeyA" },
      { t: 125, type: "keyup", code: "KeyA" },
    ],
  });
  assert.equal(res.status, 204);

  const sess = await pool.query(`SELECT * FROM behavior_sessions WHERE id = $1`, [sessionId]);
  assert.equal(sess.rows.length, 1);
  assert.equal(sess.rows[0].phase, "message");
  assert.equal(sess.rows[0].delivery_id, deliveryId);
  assert.equal(sess.rows[0].viewport_w, 1280);
  assert.equal(sess.rows[0].sample_count, 4);

  const events = await pool.query(
    `SELECT t_ms, event_type, x, y, key_code FROM behavior_events WHERE behavior_session_id = $1 ORDER BY t_ms`,
    [sessionId]
  );
  assert.equal(events.rows.length, 4);
  assert.deepEqual(events.rows.map((r) => r.event_type), ["mousemove", "mousemove", "keydown", "keyup"]);
  assert.equal(events.rows[0].x, 10);
  assert.equal(events.rows[2].key_code, "KeyA");
  assert.equal(events.rows[2].x, null, "keydown no trae coordenadas");
});

test("un segundo lote de la misma sesión acumula sample_count en vez de duplicar la sesión", async () => {
  const stamp = Date.now();
  const { token } = await setupParticipant(stamp);
  const sessionId = crypto.randomUUID();

  await postBehavior(token, { session_id: sessionId, phase: "app", samples: [{ t: 0, type: "click", x: 1, y: 1 }] });
  const res2 = await postBehavior(token, { session_id: sessionId, phase: "app", samples: [
    { t: 50, type: "click", x: 2, y: 2 }, { t: 60, type: "click", x: 3, y: 3 },
  ] });
  assert.equal(res2.status, 204);

  const sess = await pool.query(`SELECT sample_count FROM behavior_sessions WHERE id = $1`, [sessionId]);
  assert.equal(sess.rows.length, 1, "sigue siendo una sola sesión");
  assert.equal(sess.rows[0].sample_count, 3, "3 muestras en total entre los dos lotes");

  const count = await pool.query(`SELECT count(*)::int AS n FROM behavior_events WHERE behavior_session_id = $1`, [sessionId]);
  assert.equal(count.rows[0].n, 3);
});

test("token inválido/vencido responde 204 sin guardar nada (no rompe la página del participante)", async () => {
  const res = await postBehavior("token-que-no-existe", {
    session_id: crypto.randomUUID(), phase: "app", samples: [{ t: 0, type: "click" }],
  });
  assert.equal(res.status, 204);
});

test("muestras inválidas dentro de un lote se descartan sin tumbar las válidas", async () => {
  const stamp = Date.now();
  const { token } = await setupParticipant(stamp);
  const sessionId = crypto.randomUUID();

  const res = await postBehavior(token, {
    session_id: sessionId, phase: "survey",
    samples: [
      { t: 0, type: "mousemove", x: 5, y: 5 },
      { t: 10, type: "paste" }, // tipo de evento no reconocido -> se descarta
      { t: "no-es-un-numero", type: "click" }, // t inválido -> se descarta
      { t: 20, type: "click", x: 6, y: 6 },
    ],
  });
  assert.equal(res.status, 204);

  const events = await pool.query(`SELECT event_type FROM behavior_events WHERE behavior_session_id = $1 ORDER BY t_ms`, [sessionId]);
  assert.deepEqual(events.rows.map((r) => r.event_type), ["mousemove", "click"], "solo quedan las 2 muestras válidas");
});

test("lote sin muestras válidas, o sin session_id, o que excede el máximo por request: 400", async () => {
  const stamp = Date.now();
  const { token } = await setupParticipant(stamp);

  const soloInvalidas = await postBehavior(token, {
    session_id: crypto.randomUUID(), phase: "app", samples: [{ t: 0, type: "paste" }],
  });
  assert.equal(soloInvalidas.status, 400);

  const sinSessionId = await postBehavior(token, { phase: "app", samples: [{ t: 0, type: "click" }] });
  assert.equal(sinSessionId.status, 400);

  const demasiadas = await postBehavior(token, {
    session_id: crypto.randomUUID(), phase: "app",
    samples: Array.from({ length: 301 }, (_, i) => ({ t: i, type: "mousemove", x: 0, y: 0 })),
  });
  assert.equal(demasiadas.status, 400);
});

test("coordenadas fuera de rango SMALLINT se clampean en vez de romper el INSERT", async () => {
  const stamp = Date.now();
  const { token } = await setupParticipant(stamp);
  const sessionId = crypto.randomUUID();

  const res = await postBehavior(token, {
    session_id: sessionId, phase: "app",
    samples: [{ t: 0, type: "mousemove", x: 999999, y: -999999 }],
  });
  assert.equal(res.status, 204);

  const ev = await pool.query(`SELECT x, y FROM behavior_events WHERE behavior_session_id = $1`, [sessionId]);
  assert.equal(ev.rows[0].x, 32767);
  assert.equal(ev.rows[0].y, -32768);
});

test("export /api/export/behavior-events.json trae rol/grupo/equipo y vector/is_attack sin external_hash", async () => {
  const stamp = Date.now();
  const { token, campaignId, deliveryId } = await setupParticipant(stamp, { group_assignment: "experimental" });
  const sessionId = crypto.randomUUID();
  await postBehavior(token, {
    session_id: sessionId, phase: "landing", delivery_id: deliveryId, viewport_w: 375, viewport_h: 812,
    samples: [{ t: 0, type: "click", x: 1, y: 2 }],
  });

  const exp = await api("GET", `/api/export/behavior-events.json?campaign_id=${campaignId}`);
  assert.equal(exp.status, 200);
  const row = exp.body.find((r) => r.session_id === sessionId);
  assert.ok(row, "la muestra insertada aparece en el export");
  assert.ok(row.participant_campaign_id, "trae un identificador de participante (interno, no external_hash)");
  assert.equal(row.role, "estudiante");
  assert.equal(row.group_assignment, "experimental");
  assert.equal(row.attack_vector, "curiosidad");
  assert.equal(row.is_attack, true);
  assert.equal(row.viewport_w, 375);
  assert.doesNotMatch(JSON.stringify(exp.body), new RegExp(`beh_${stamp}`), "el export no expone external_hash");
  assert.ok(!("external_hash" in row), "el export no incluye la columna external_hash");
});

test("export exige x-api-key (mismo criterio que el resto de /api/export)", async () => {
  const res = await fetch(`${baseUrl}/api/export/behavior-events.json`);
  assert.equal(res.status, 401);
});
