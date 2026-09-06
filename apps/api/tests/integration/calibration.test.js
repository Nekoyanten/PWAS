// Prueba de integración del paso 2 del protocolo (TG §9.5): calibración de
// ~30s entre el consentimiento y la tarea de navegación. Ver el comentario
// sobre renderCalibration() en apps/api/src/lib/decoy.js para el porqué del
// diseño (línea base de mouse/teclado ANTES de cualquier estímulo).
//
// Verifica que:
//  - antes de consentir, /calibration redirige al consentimiento (no se
//    puede saltar directo a la calibración con la URL);
//  - al consentir, el flujo entra a /calibration, NO directo a /app;
//  - ir a /app sin haber completado la calibración redirige de vuelta a
//    /calibration — no se puede saltar el paso cambiando la URL a mano;
//  - GET /calibration registra calibration_started_at la primera vez, y no
//    lo pisa en visitas repetidas;
//  - POST /calibration/complete registra calibration_completed_at y desde
//    ahí /app funciona con normalidad;
//  - revisitar /calibration después de completarla salta directo a /app
//    (no repite la tarea neutra dos veces);
//  - la pantalla de calibración no contiene ningún contenido de ataque (es
//    neutra, TG §9.5) y sí incluye la etiqueta de captura conductual con
//    phase="calibration";
//  - el reset de un participante también borra su calibración, para que la
//    repita si vuelve a hacer la prueba.
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
const hop = (path, opts) => fetch(`${baseUrl}${path}`, { redirect: "manual", ...opts });
const form = (path, data) => hop(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: data });
const completeCalibration = (token) => hop(`/t/${token}/calibration/complete`, { method: "POST" });

// Crea campaña + un participante SIN consentir todavía. Devuelve token/pcId.
async function setupParticipant(stamp) {
  const c = await api("POST", "/api/campaigns", { name: `Cal ${stamp}` });
  const campaignId = c.body.campaign.id;
  const team = `CalTeam ${stamp}`;
  await api("POST", "/api/participants/import", {
    participants: [{ external_hash: `cal_${stamp}`, role: "estudiante", team_label: team }],
  });
  await api("POST", `/api/campaigns/${campaignId}/generate-tokens`, {});
  const token = (await pool.query(
    `SELECT access_token FROM participant_campaign pc JOIN participants p ON p.id = pc.participant_id WHERE p.external_hash = $1`,
    [`cal_${stamp}`]
  )).rows[0].access_token;
  const pcId = (await pool.query(`SELECT id FROM participant_campaign WHERE access_token = $1`, [token])).rows[0].id;
  return { token, campaignId, pcId };
}

test("GET /calibration antes de consentir redirige al consentimiento", async () => {
  const { token } = await setupParticipant(Date.now());
  const res = await hop(`/t/${token}/calibration`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), new RegExp(`/t/${token}$`));
});

test("consentir entra a /calibration, no directo a /app", async () => {
  const { token } = await setupParticipant(Date.now());
  const consent = await form(`/t/${token}/consent`, "consent=1");
  assert.equal(consent.status, 302);
  assert.match(consent.headers.get("location"), /\/calibration$/);
});

test("ir a /app sin completar la calibración redirige de vuelta a /calibration", async () => {
  const { token } = await setupParticipant(Date.now());
  await form(`/t/${token}/consent`, "consent=1");
  const res = await hop(`/t/${token}/app`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /\/calibration$/);
});

test("GET /calibration registra calibration_started_at una sola vez", async () => {
  const { token, pcId } = await setupParticipant(Date.now());
  await form(`/t/${token}/consent`, "consent=1");

  const html = await (await hop(`/t/${token}/calibration`)).text();
  assert.match(html, /Antes de comenzar/, "muestra la pantalla de calibración");
  assert.match(html, /data-phase="calibration"/, "activa la captura conductual con phase=calibration");

  const first = (await pool.query(`SELECT calibration_started_at FROM participant_campaign WHERE id = $1`, [pcId])).rows[0].calibration_started_at;
  assert.ok(first, "queda registrado calibration_started_at");

  await new Promise((r) => setTimeout(r, 20));
  await hop(`/t/${token}/calibration`);
  const second = (await pool.query(`SELECT calibration_started_at FROM participant_campaign WHERE id = $1`, [pcId])).rows[0].calibration_started_at;
  assert.equal(new Date(second).getTime(), new Date(first).getTime(), "no se pisa en visitas repetidas");
});

test("la pantalla de calibración es neutra: sin contenido de ataque ni bandeja", async () => {
  const { token } = await setupParticipant(Date.now());
  await form(`/t/${token}/consent`, "consent=1");
  const html = await (await hop(`/t/${token}/calibration`)).text();
  assert.doesNotMatch(html, /Bandeja de entrada/i, "no es el tablero de TaskFlow");
  assert.doesNotMatch(html, /urgencia|autoridad|escasez|prueba social|curiosidad/i, "no menciona ningún vector de ataque");
});

test("POST /calibration/complete registra calibration_completed_at y habilita /app", async () => {
  const { token, pcId } = await setupParticipant(Date.now());
  await form(`/t/${token}/consent`, "consent=1");
  await hop(`/t/${token}/calibration`);

  const done = await completeCalibration(token);
  assert.equal(done.status, 302);
  assert.match(done.headers.get("location"), /\/app$/);

  const row = (await pool.query(`SELECT calibration_completed_at FROM participant_campaign WHERE id = $1`, [pcId])).rows[0];
  assert.ok(row.calibration_completed_at);

  assert.equal((await hop(`/t/${token}/app`)).status, 200);
});

test("revisitar /calibration después de completarla salta directo a /app", async () => {
  const { token } = await setupParticipant(Date.now());
  await form(`/t/${token}/consent`, "consent=1");
  await completeCalibration(token);

  const res = await hop(`/t/${token}/calibration`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /\/app$/);
});

test("el reset de un participante borra su calibración para que la repita", async () => {
  const { token, campaignId, pcId } = await setupParticipant(Date.now());
  await form(`/t/${token}/consent`, "consent=1");
  await completeCalibration(token);

  let row = (await pool.query(`SELECT calibration_started_at, calibration_completed_at FROM participant_campaign WHERE id = $1`, [pcId])).rows[0];
  assert.ok(row.calibration_started_at && row.calibration_completed_at);

  await api("POST", `/api/campaigns/${campaignId}/participants/${pcId}/reset`);
  row = (await pool.query(`SELECT calibration_started_at, calibration_completed_at FROM participant_campaign WHERE id = $1`, [pcId])).rows[0];
  assert.equal(row.calibration_started_at, null);
  assert.equal(row.calibration_completed_at, null);

  // el reset también borra el consentimiento, así que /app manda de vuelta
  // al inicio; al volver a consentir, el gate de calibración vuelve a aplicar
  const res = await hop(`/t/${token}/app`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), new RegExp(`/t/${token}$`));

  const consent2 = await form(`/t/${token}/consent`, "consent=1");
  assert.match(consent2.headers.get("location"), /\/calibration$/, "tras el reset, la calibración se vuelve a pedir");
});
