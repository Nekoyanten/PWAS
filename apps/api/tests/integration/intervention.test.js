// Prueba de integración de la capa de intervención PAWS (jolting, TG §8.2.5)
// y de su condición de activación por grupo (TG §9.2: control vs.
// experimental). Antes de esta funcionalidad, `participants.group_assignment`
// se guardaba pero ningún endpoint lo leía, así que el grupo experimental
// recibía el mismo flujo que el control (ver Notion: "Cap. VIII/IX — activar
// la intervención PAWS por grupo").
//
// Verifica que:
//  - el grupo control (o sin grupo) sigue viendo el aterrizaje directo, sin
//    interstitial (no debe romperse el comportamiento anterior);
//  - el grupo experimental ve la intervención antes del aterrizaje, una sola
//    vez por delivery;
//  - "cancelar" registra 'intervencion_cancelada' y NO cuenta como caída
//    (fell_for_attack = false), aunque el participante haya abierto el
//    mensaje;
//  - "continuar de todas formas" registra abierto+clic igual que el control
//    y sí cuenta como caída.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db.js";

process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "test_key_local_only";

let server, baseUrl;
const key = process.env.ADMIN_API_KEY;
const jh = { "x-api-key": key, "Content-Type": "application/json" };

before(async () => { server = createApp().listen(0); baseUrl = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: jh, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const hop = (path, opts = {}) => fetch(`${baseUrl}${path}`, { redirect: "manual", ...opts });
const form = (path, data) => hop(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: data });
// Desde el parche de calibración (TG §9.5, paso 2): consentimiento ya no
// entra directo a /app, pasa primero por /calibration.
const completeCalibration = (token) => hop(`/t/${token}/calibration/complete`, { method: "POST" });

// Crea plantilla + campaña + un participante del grupo dado, lo suscribe,
// consiente, envía un ataque y devuelve { token, deliveryId, pcId }.
async function setupAttackFor(groupAssignment) {
  const t = await api("POST", "/api/templates", {
    name: `Interv ${groupAssignment} ${Date.now()}`, vector: "urgencia", kind: "email", is_attack: true,
    sender_label: "Seguridad", subject_or_headline: "Tu sesión expira", message_body: "<p>Verifica ya.</p>",
    cta_label: "Verificar", landing_kind: "form",
  });
  const c = await api("POST", "/api/campaigns", { name: `CampInterv ${Date.now()}`, template_ids: [t.body.template.id] });
  const campaignId = c.body.campaign.id;
  const team = `EquipoInterv ${Date.now()}`;
  const p = await api("POST", "/api/participants/import", {
    participants: [{ external_hash: `interv_${groupAssignment}_${Date.now()}`, role: "estudiante", team_label: team, group_assignment: groupAssignment }],
  });
  const gen = await api("POST", `/api/campaigns/${campaignId}/generate-tokens`, { participant_ids: [p.body.participants[0].id] });
  const token = gen.body.links[0].url.split("/").pop();
  const msg = await api("POST", `/api/campaigns/${campaignId}/messages`, { template_id: t.body.template.id, kind: "email" });
  await api("POST", `/api/messages/${msg.body.message.id}/send`, { team_labels: [team] });
  await form(`/t/${token}/consent`, "consent=1");
  await completeCalibration(token);
  const inboxHtml = await (await hop(`/t/${token}/app`)).text();
  const deliveryId = inboxHtml.match(/\/t\/[^/]+\/d\/([0-9a-f-]{36})/)[1];
  const pcId = (await pool.query(`SELECT id FROM participant_campaign WHERE access_token = $1`, [token])).rows[0].id;
  return { token, deliveryId, pcId };
}

async function eventTypes(deliveryId) {
  const r = await pool.query(`SELECT event_type FROM events WHERE delivery_id = $1 ORDER BY occurred_at`, [deliveryId]);
  return r.rows.map((x) => x.event_type);
}

test("grupo control: /go sigue yendo directo al aterrizaje (sin interstitial)", async () => {
  const { token, deliveryId } = await setupAttackFor("control");
  const res = await hop(`/t/${token}/d/${deliveryId}/go`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.doesNotMatch(html, /Espera un momento antes de continuar/);
  assert.match(html, /name="p"/); // aterrizaje form, como antes
  assert.deepEqual(await eventTypes(deliveryId), ["entregado", "abierto", "clic"]);
});

test("participante sin grupo asignado (null): mismo comportamiento que control", async () => {
  const { token, deliveryId } = await setupAttackFor(null);
  const res = await hop(`/t/${token}/d/${deliveryId}/go`);
  assert.doesNotMatch(await res.text(), /Espera un momento antes de continuar/);
  assert.deepEqual(await eventTypes(deliveryId), ["entregado", "abierto", "clic"]);
});

test("grupo experimental: /go muestra la intervención antes del aterrizaje, una sola vez", async () => {
  const { token, deliveryId } = await setupAttackFor("experimental");

  const first = await hop(`/t/${token}/d/${deliveryId}/go`);
  const html = await first.text();
  assert.equal(first.status, 200);
  assert.match(html, /Espera un momento antes de continuar/);
  assert.match(html, /Cancelar y volver/);
  assert.deepEqual(await eventTypes(deliveryId), ["entregado", "intervencion_mostrada"], "abrir el enlace no cuenta todavía como 'abierto'/'clic'");

  // Revisitar el mismo enlace ya no debe repetir el interstitial.
  const second = await hop(`/t/${token}/d/${deliveryId}/go`);
  assert.doesNotMatch(await second.text(), /Espera un momento antes de continuar/);
  assert.deepEqual(await eventTypes(deliveryId), ["entregado", "intervencion_mostrada", "abierto", "clic"]);
});

test("grupo experimental: cancelar registra la reversión y NO cuenta como caída", async () => {
  const { token, deliveryId, pcId } = await setupAttackFor("experimental");
  await hop(`/t/${token}/d/${deliveryId}/go`); // dispara el interstitial

  const cancel = await hop(`/t/${token}/d/${deliveryId}/cancel`, { method: "POST" });
  assert.equal(cancel.status, 302);
  assert.match(cancel.headers.get("location"), /\/app$/);
  assert.deepEqual(await eventTypes(deliveryId), ["entregado", "intervencion_mostrada", "intervencion_cancelada"]);

  await hop(`/t/${token}/finish`, { method: "POST" });
  await form(`/t/${token}/survey`,
    "perceived_suspicion_before_action=true&recognized_as_simulated=false&fall_reason=no_aplica&vector_specific_answer=x");
  const s = await pool.query(
    `SELECT fell_for_attack FROM post_session_survey WHERE participant_campaign_id = $1`, [pcId]);
  assert.equal(s.rows[0].fell_for_attack, false, "cancelar desde la intervención no debe registrarse como caída");
});

test("grupo experimental: continuar de todas formas registra abierto+clic igual que el control y sí cuenta como caída", async () => {
  const { token, deliveryId, pcId } = await setupAttackFor("experimental");
  await hop(`/t/${token}/d/${deliveryId}/go`); // dispara el interstitial

  const proceed = await hop(`/t/${token}/d/${deliveryId}/proceed`, { method: "POST" });
  assert.equal(proceed.status, 200);
  assert.match(await proceed.text(), /name="p"/); // mismo aterrizaje que el control
  assert.deepEqual(await eventTypes(deliveryId), ["entregado", "intervencion_mostrada", "abierto", "clic"]);

  await hop(`/t/${token}/finish`, { method: "POST" });
  await form(`/t/${token}/survey`,
    "perceived_suspicion_before_action=false&recognized_as_simulated=false&fall_reason=urgencia_temporal&vector_specific_answer=x");
  const s = await pool.query(
    `SELECT fell_for_attack FROM post_session_survey WHERE participant_campaign_id = $1`, [pcId]);
  assert.equal(s.rows[0].fell_for_attack, true, "continuar tras la intervención sí cuenta como caída, igual que el control");
});
