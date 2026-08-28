// Prueba de integración end-to-end: crea plantilla + campaña + participante,
// genera un token y recorre el flujo entregado -> abierto -> clic -> intento_envio,
// verificando que las métricas agregadas reflejan la caída sin exponer identidad.
//
// Requiere DATABASE_URL apuntando a una base con el esquema ya cargado
// (ver README: "Cómo correr las pruebas").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db.js";

process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "test_key_local_only";

let server;
let baseUrl;
const headers = { "x-api-key": process.env.ADMIN_API_KEY, "Content-Type": "application/json" };

before(async () => {
  const app = createApp();
  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://localhost:${port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

test("flujo completo: entrega -> apertura -> clic -> intento de envío -> encuesta -> métricas agregadas", async () => {
  // 1) plantilla
  const tRes = await fetch(`${baseUrl}/api/templates`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Test — urgencia",
      vector: "urgencia",
      channel: "web",
      subject_or_headline: "Aviso de prueba",
      body_ref: "test-template",
    }),
  });
  assert.equal(tRes.status, 201);
  const { template } = await tRes.json();

  // 2) campaña
  const cRes = await fetch(`${baseUrl}/api/campaigns`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Campaña de prueba", template_id: template.id }),
  });
  assert.equal(cRes.status, 201);
  const { campaign } = await cRes.json();

  // 3) participante (hash sintético, con consentimiento y equipo asignado).
  // El team_label incluye un sufijo único para que el test sea idempotente
  // al correr npm test varias veces seguidas contra la misma base local.
  const teamLabel = `Equipo TEST ${Date.now()}`;
  const pRes = await fetch(`${baseUrl}/api/participants/import`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      participants: [
        { external_hash: `test_hash_${Date.now()}`, role: "estudiante", team_label: teamLabel, group_assignment: "experimental", consent_given: true },
      ],
    }),
  });
  assert.equal(pRes.status, 201);
  const { participants } = await pRes.json();
  const participantId = participants[0].id;

  // 4) generar token para ese participante en la campaña
  const genRes = await fetch(`${baseUrl}/api/campaigns/${campaign.id}/generate-tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({ participant_ids: [participantId] }),
  });
  assert.equal(genRes.status, 201);
  const { links } = await genRes.json();
  assert.equal(links.length, 1);
  const token = links[0].url.split("/").pop();

  // 5) el participante abre el enlace (público, sin x-api-key)
  const openRes = await fetch(`${baseUrl}/t/${token}`);
  assert.equal(openRes.status, 200);

  // 6) hace clic
  const clickRes = await fetch(`${baseUrl}/t/${token}/click`);
  assert.equal(clickRes.status, 200);

  // 7) intenta enviar el formulario — SIN payload de credenciales
  const submitRes = await fetch(`${baseUrl}/t/${token}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(submitRes.status, 200);
  const submitBody = await submitRes.json();
  assert.equal(submitBody.ok, true);

  // 8) encuesta post-sesión
  const surveyRes = await fetch(`${baseUrl}/t/${token}/survey`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fall_reason: "urgencia_temporal", recognized_as_simulated: false }),
  });
  assert.equal(surveyRes.status, 201);
  const { survey } = await surveyRes.json();
  assert.equal(survey.fell_for_attack, true, "fell_for_attack debe calcularse automáticamente a partir de los eventos, no del autorreporte");

  // 9) el dashboard agregado por equipo debe reflejar 1 caída en "Equipo TEST",
  //    sin exponer el hash ni el id del participante en ninguna parte de la respuesta.
  const dashRes = await fetch(`${baseUrl}/api/dashboard/by-team`, { headers: { "x-api-key": process.env.ADMIN_API_KEY } });
  assert.equal(dashRes.status, 200);
  const dash = await dashRes.json();
  const testTeam = dash.resumen_por_equipo.find((r) => r.team_label === teamLabel);
  assert.ok(testTeam, "el equipo de prueba debe aparecer en el resumen");
  // node-pg devuelve COUNT(...) como string (bigint) para no perder precisión — se compara como número.
  assert.equal(Number(testTeam.total_caidos), 1);

  const dashJson = JSON.stringify(dash);
  assert.doesNotMatch(dashJson, /test_hash_/, "el dashboard agregado nunca debe exponer el external_hash");
});

test("las rutas /api/* rechazan peticiones sin x-api-key", async () => {
  const res = await fetch(`${baseUrl}/api/dashboard/overview`);
  assert.equal(res.status, 401);
});

test("/t/:token/submit nunca persiste el contenido de un formulario aunque se envíe por error", async () => {
  // Genera un participante/campaña/token nuevo rápido para esta prueba puntual.
  const tRes = await fetch(`${baseUrl}/api/templates`, {
    method: "POST", headers,
    body: JSON.stringify({ name: "Test2", vector: "curiosidad", channel: "web", subject_or_headline: "x", body_ref: "x" }),
  });
  const { template } = await tRes.json();
  const cRes = await fetch(`${baseUrl}/api/campaigns`, {
    method: "POST", headers, body: JSON.stringify({ name: "Campaña 2", template_id: template.id }),
  });
  const { campaign } = await cRes.json();
  const pRes = await fetch(`${baseUrl}/api/participants/import`, {
    method: "POST", headers,
    body: JSON.stringify({ participants: [{ external_hash: `test_hash_b_${Date.now()}`, role: "estudiante", consent_given: true }] }),
  });
  const { participants } = await pRes.json();
  const genRes = await fetch(`${baseUrl}/api/campaigns/${campaign.id}/generate-tokens`, {
    method: "POST", headers, body: JSON.stringify({ participant_ids: [participants[0].id] }),
  });
  const { links } = await genRes.json();
  const token = links[0].url.split("/").pop();

  // Envía intencionalmente credenciales "de prueba" en el body para confirmar que se ignoran.
  const submitRes = await fetch(`${baseUrl}/t/${token}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "no_deberia_guardarse", pass: "tampoco_esto" }),
  });
  assert.equal(submitRes.status, 200);

  const evRes = await pool.query(
    `SELECT * FROM events e JOIN participant_campaign pc ON pc.id = e.participant_campaign_id WHERE pc.access_token = $1`,
    [token]
  );
  const raw = JSON.stringify(evRes.rows);
  assert.doesNotMatch(raw, /no_deberia_guardarse/);
  assert.doesNotMatch(raw, /tampoco_esto/);
});
