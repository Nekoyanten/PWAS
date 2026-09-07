// Prueba de integración del motor de decisión por riesgo (TG §8.2.5, Tabla 1
// §8.2.1 fila 5, migración 007), MODO SOMBRA -- contra Postgres real.
//
// Contexto: hasta ahora la intervención (jolting) se decidía con un sorteo de
// probabilidad fijo por envío (jolting_roll, migración 006). Este módulo
// agrega, en paralelo y sin tocar esa decisión, un puntaje de riesgo REAL
// calculado por el modelo temporal (TCN+Transformer, ml/src/) sobre la
// captura conductual de cada participante en el mensaje que acaba de leer --
// pero en modo SOMBRA: se calcula y se guarda para análisis, sin decidir
// todavía a quién se le muestra la intervención de verdad (el modelo se
// entrenó con etiquetas sintéticas, ver docs/2026-09-07_motor-decision-riesgo.md).
//
// Verifica que:
//  - PATCH /api/campaigns/:id/risk-threshold valida (0..1) y persiste;
//  - GET /:token/d/:deliveryId/go, con captura conductual real ya enviada
//    para la fase 'message' de ese delivery, deja un risk_score en [0,1],
//    un risk_model_version (sha256 del .onnx) y risk_would_trigger
//    coherente con el umbral vigente -- calculado EN SEGUNDO PLANO, sin
//    agregarle latencia perceptible a la respuesta;
//  - sin ninguna captura conductual para ese delivery, el cálculo falla con
//    gracia (risk_score_error explicando por qué) sin afectar la respuesta
//    HTTP al participante;
//  - el modo SOMBRA es real: la respuesta de /go (interstitial sí/no) sigue
//    dependiendo SOLO de jolting_roll/jolting_probability, nunca del puntaje
//    de riesgo calculado -- con probability=0 nunca debe salir el aviso, sin
//    importar qué tan alto salga risk_score;
//  - GET /api/dashboard/risk-summary agrega por grupo sin exponer una fila
//    por participante.
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

async function waitFor(fn, { timeoutMs = 3000, intervalMs = 30 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor: tiempo de espera agotado");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Campaña + un ataque enviado a UN participante del grupo dado, ya
// consentido y calibrado. Igual patrón que las demás suites de integración.
async function setupAttack(stamp, { group = "experimental", probability = 1 } = {}) {
  const t = await api("POST", "/api/templates", {
    name: `Risk ${stamp}`, vector: "urgencia", kind: "email", is_attack: true,
    sender_label: "Seguridad", subject_or_headline: "Verifica tu cuenta", message_body: "<p>Haz clic ya.</p>",
    cta_label: "Verificar", landing_kind: "form",
  });
  const c = await api("POST", "/api/campaigns", { name: `CampRisk ${stamp}` });
  const campaignId = c.body.campaign.id;
  if (probability !== 1) {
    const patched = await api("PATCH", `/api/campaigns/${campaignId}/jolting`, { probability });
    assert.equal(patched.status, 200);
  }
  const team = `EquipoRisk ${stamp}`;
  const imp = await api("POST", "/api/participants/import", {
    participants: [{ external_hash: `risk_${stamp}`, role: "estudiante", team_label: team, group_assignment: group }],
  });
  const participantId = imp.body.participants[0].id;
  await api("POST", `/api/campaigns/${campaignId}/generate-tokens`, { participant_ids: [participantId] });
  const msg = await api("POST", `/api/campaigns/${campaignId}/messages`, {
    template_id: t.body.template.id, kind: "email",
  });
  const messageId = msg.body.message.id;
  const send = await api("POST", `/api/messages/${messageId}/send`, { team_labels: [team] });
  assert.equal(send.body.delivered, 1);

  const token = (await pool.query(
    `SELECT access_token FROM participant_campaign pc JOIN participants p ON p.id = pc.participant_id WHERE p.external_hash = $1`,
    [`risk_${stamp}`]
  )).rows[0].access_token;
  await form(`/t/${token}/consent`, "consent=1");
  await completeCalibration(token);
  const deliveryId = (await (await hop(`/t/${token}/app`)).text()).match(/\/d\/([0-9a-f-]{36})/)[1];
  return { campaignId, messageId, token, deliveryId };
}

// Un lote de captura conductual "real" para la fase 'message' de un
// delivery: suficientes mousemove con jitter + un par de teclas, como para
// que el modelo tenga algo no trivial que procesar (no solo 0-1 puntos).
function realisticBehaviorPayload(deliveryId) {
  const samples = [];
  let t = 0;
  for (let i = 0; i < 20; i++) {
    t += 35 + (i % 3) * 5; // jitter, no una rejilla perfecta
    samples.push({ t, type: "mousemove", x: 100 + i * 15, y: 200 + (i % 4) * 8 });
  }
  samples.push({ t: t + 50, type: "keydown", code: "KeyA" });
  samples.push({ t: t + 90, type: "keyup", code: "KeyA" });
  return {
    session_id: crypto.randomUUID(), phase: "message", delivery_id: deliveryId,
    viewport_w: 1920, viewport_h: 945, samples,
  };
}

/* ---------------------- PATCH /api/campaigns/:id/risk-threshold ---------------------- */

test("PATCH risk-threshold: valida el rango (0..1) y persiste el valor", async () => {
  const c = await api("POST", "/api/campaigns", { name: `RiskThresh ${Date.now()}` });
  const campaignId = c.body.campaign.id;

  const bad1 = await api("PATCH", `/api/campaigns/${campaignId}/risk-threshold`, { threshold: 1.5 });
  assert.equal(bad1.status, 400);
  const bad2 = await api("PATCH", `/api/campaigns/${campaignId}/risk-threshold`, { threshold: -0.1 });
  assert.equal(bad2.status, 400);
  const bad3 = await api("PATCH", `/api/campaigns/${campaignId}/risk-threshold`, { threshold: "no-es-numero" });
  assert.equal(bad3.status, 400);

  const ok = await api("PATCH", `/api/campaigns/${campaignId}/risk-threshold`, { threshold: 0.75 });
  assert.equal(ok.status, 200);
  assert.equal(Number(ok.body.campaign.risk_threshold), 0.75);

  const notFound = await api("PATCH", `/api/campaigns/00000000-0000-0000-0000-000000000000/risk-threshold`, { threshold: 0.5 });
  assert.equal(notFound.status, 404);
});

test("una campaña recién creada trae risk_threshold=0.5 por defecto (compatibilidad hacia atrás)", async () => {
  const c = await api("POST", "/api/campaigns", { name: `RiskDefault ${Date.now()}` });
  assert.equal(Number(c.body.campaign.risk_threshold), 0.5);
});

/* ------------------------- cálculo end-to-end con captura real ------------------------- */

test("GET /go con captura conductual real: calcula y guarda risk_score/risk_would_trigger/risk_model_version en segundo plano", async () => {
  const stamp = Date.now();
  const { token, deliveryId } = await setupAttack(stamp, { group: "control" }); // control: sin interstitial, más simple de aislar
  const res = await postBehavior(token, realisticBehaviorPayload(deliveryId));
  assert.equal(res.status, 204);

  const goRes = await hop(`/t/${token}/d/${deliveryId}/go`);
  assert.equal(goRes.status, 200);
  await goRes.text();

  const row = await waitFor(async () => {
    const r = await pool.query(`SELECT * FROM deliveries WHERE id = $1`, [deliveryId]);
    return r.rows[0].risk_scored_at ? r.rows[0] : null;
  });

  assert.equal(row.risk_score_error, null, "no debería haber error con captura conductual real presente");
  assert.ok(row.risk_score !== null, "risk_score debe quedar poblado");
  const score = Number(row.risk_score);
  assert.ok(score >= 0 && score <= 1, `risk_score fuera de rango: ${score}`);
  assert.match(row.risk_model_version, /^[0-9a-f]{64}$/, "risk_model_version debe ser el sha256 del .onnx");
  assert.equal(row.risk_would_trigger, score >= 0.5, "risk_would_trigger debe coincidir con el umbral por defecto (0.5)");
});

test("GET /go SIN ninguna captura conductual: no revienta, y guarda un risk_score_error explicativo en vez de un risk_score", async () => {
  const stamp = Date.now() + 1;
  const { token, deliveryId } = await setupAttack(stamp, { group: "control" });

  const goRes = await hop(`/t/${token}/d/${deliveryId}/go`);
  assert.equal(goRes.status, 200, "la respuesta al participante no se ve afectada por la falta de captura conductual");
  const html = await goRes.text();
  assert.match(html, /name="p"/, "sigue llegando al aterrizaje con normalidad");

  const row = await waitFor(async () => {
    const r = await pool.query(`SELECT * FROM deliveries WHERE id = $1`, [deliveryId]);
    return r.rows[0].risk_scored_at ? r.rows[0] : null;
  });
  assert.equal(row.risk_score, null);
  assert.ok(row.risk_score_error && row.risk_score_error.length > 0, "debe quedar un motivo legible");
});

test("el cálculo de riesgo no retrasa la respuesta al participante (se dispara después de responder)", async () => {
  const stamp = Date.now() + 2;
  const { token, deliveryId } = await setupAttack(stamp, { group: "control" });
  await postBehavior(token, realisticBehaviorPayload(deliveryId));

  const start = Date.now();
  const goRes = await hop(`/t/${token}/d/${deliveryId}/go`);
  await goRes.text();
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 300, `la respuesta tardó ${elapsedMs}ms -- el cálculo de riesgo no debería agregarle latencia perceptible`);
});

/* ----------------------------- modo SOMBRA real ----------------------------- */

test("MODO SOMBRA: con jolting_probability=0, el aviso NUNCA sale, sin importar el risk_score calculado", async () => {
  const stamp = Date.now() + 3;
  const { token, deliveryId } = await setupAttack(stamp, { group: "experimental", probability: 0 });
  await postBehavior(token, realisticBehaviorPayload(deliveryId));

  const html = await (await hop(`/t/${token}/d/${deliveryId}/go`)).text();
  assert.doesNotMatch(html, /Espera un momento antes de continuar/, "probability=0 debe ganarle a cualquier risk_score");

  // Confirma que el puntaje sí se calculó (no es que el motor esté apagado) --
  // simplemente no se usa todavía para decidir nada real.
  await waitFor(async () => {
    const r = await pool.query(`SELECT risk_scored_at, risk_score FROM deliveries WHERE id = $1`, [deliveryId]);
    return r.rows[0].risk_scored_at ? r.rows[0] : null;
  });
});

/* ------------------------------ risk-summary ------------------------------ */

test("GET /api/dashboard/risk-summary agrega por grupo, nunca una fila por participante", async () => {
  const stamp = Date.now() + 4;
  const { campaignId, token: tokenExp, deliveryId: dExp } = await setupAttack(stamp, { group: "experimental" });
  await postBehavior(tokenExp, realisticBehaviorPayload(dExp));
  await hop(`/t/${tokenExp}/d/${dExp}/go`);

  await waitFor(async () => {
    const r = await pool.query(`SELECT risk_scored_at FROM deliveries WHERE id = $1`, [dExp]);
    return r.rows[0].risk_scored_at ? true : null;
  });

  const summary = await api("GET", `/api/dashboard/risk-summary?campaign_id=${campaignId}`);
  assert.equal(summary.status, 200);
  assert.ok(Array.isArray(summary.body.por_grupo));
  const grupoExp = summary.body.por_grupo.find((g) => g.grupo === "experimental");
  assert.ok(grupoExp, "debe traer una fila agregada para 'experimental'");
  assert.equal(grupoExp.ataques_totales, 1);
  assert.equal(grupoExp.puntuados, 1);
  for (const row of summary.body.por_grupo) {
    assert.ok(!("participant_id" in row) && !("external_hash" in row), "nunca debe exponer identidad individual");
  }
});
