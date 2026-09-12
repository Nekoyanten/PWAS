// Prueba de integración end-to-end del modelo mensajes + deliveries:
// crea plantilla + campaña + participante, redacta un mensaje de ataque y lo
// ENVÍA por equipo, y recorre consentimiento -> app -> abrir mensaje -> clic
// -> intento_envio -> finalizar -> encuesta -> debrief. Verifica que:
//  - fell_for_attack se calcula de los eventos, no del autorreporte,
//  - reabrir el mismo mensaje no duplica eventos,
//  - un reenvío (mensaje clonado) se mide por separado,
//  - el dashboard agregado nunca expone external_hash,
//  - /submit nunca persiste el contenido del formulario.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import { assignBalanced } from "../../src/lib/rng.js";
import { cleanupTestData } from "../helpers/cleanup.js";

process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "test_key_local_only";

let server, baseUrl;
const key = process.env.ADMIN_API_KEY;
const jh = { "x-api-key": key, "Content-Type": "application/json" };

before(async () => { server = createApp().listen(0); baseUrl = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await cleanupTestData(); await pool.end(); });

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: jh, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const hop = (path, opts = {}) => fetch(`${baseUrl}${path}`, { redirect: "manual", ...opts });
const form = (path, data) => hop(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: data });
// Desde el parche de calibración (TG §9.5, paso 2): consentimiento ya no
// entra directo a /app, pasa primero por /calibration.
const completeCalibration = (token) => hop(`/t/${token}/calibration/complete`, { method: "POST" });

test("assignBalanced es determinista y balanceado", () => {
  const r1 = assignBalanced(["a", "b", "c"], 9, "s");
  assert.deepEqual(r1, assignBalanced(["a", "b", "c"], 9, "s"));
  assert.deepEqual(["a", "b", "c"].map((o) => r1.filter((x) => x === o).length).sort(), [3, 3, 3]);
});

test("flujo completo mensajes+deliveries: envío -> caída -> encuesta -> debrief -> métricas", async () => {
  const t = await api("POST", "/api/templates", {
    name: `Auth ${Date.now()}`, vector: "autoridad", kind: "email", is_attack: true, channel: "web",
    sender_label: "Coordinación", subject_or_headline: "Confirma tus datos",
    message_body: "<p>Confirma ya.</p>", cta_label: "Confirmar", landing_kind: "form",
  });
  assert.equal(t.status, 201);

  const c = await api("POST", "/api/campaigns", { name: `Camp ${Date.now()}`, template_ids: [t.body.template.id] });
  assert.equal(c.status, 201);
  const campaignId = c.body.campaign.id;

  const team = `Equipo IT ${Date.now()}`;
  const hash = `it_hash_${Date.now()}`;
  const p = await api("POST", "/api/participants/import", { participants: [{ external_hash: hash, role: "estudiante", team_label: team }] });
  assert.equal(p.status, 201);

  const gen = await api("POST", `/api/campaigns/${campaignId}/generate-tokens`, { participant_ids: [p.body.participants[0].id] });
  assert.equal(gen.status, 201);
  const token = gen.body.links[0].url.split("/").pop();

  // redactar el mensaje de ataque desde la plantilla y enviarlo al equipo
  const msg = await api("POST", `/api/campaigns/${campaignId}/messages`, { template_id: t.body.template.id, kind: "email" });
  assert.equal(msg.status, 201);
  assert.equal(msg.body.message.is_attack, true);
  const send = await api("POST", `/api/messages/${msg.body.message.id}/send`, { team_labels: [team] });
  assert.equal(send.body.delivered, 1);

  // el participante entra -> consentimiento -> calibración -> app
  assert.match(await (await hop(`/t/${token}`)).text(), /piloto de usabilidad/i);
  const consent = await form(`/t/${token}/consent`, "consent=1");
  assert.equal(consent.status, 302);
  assert.match(consent.headers.get("location"), /\/calibration$/, "el consentimiento entra primero a la calibración, no directo a /app");
  // ir directo a /app sin haber completado la calibración redirige de vuelta
  const skip = await hop(`/t/${token}/app`);
  assert.equal(skip.status, 302);
  assert.match(skip.headers.get("location"), /\/calibration$/);
  await completeCalibration(token);
  assert.equal((await hop(`/t/${token}/app`)).status, 200);

  // localizar el delivery del ataque en la bandeja
  const inboxHtml = await (await hop(`/t/${token}/app`)).text();
  const deliveryId = inboxHtml.match(/\/t\/[^/]+\/d\/([0-9a-f-]{36})/)[1];

  // abrir el mensaje dos veces -> un solo 'abierto'
  await hop(`/t/${token}/d/${deliveryId}`);
  await hop(`/t/${token}/d/${deliveryId}`);
  const opens = await pool.query(`SELECT COUNT(*)::int n FROM events WHERE delivery_id = $1 AND event_type = 'abierto'`, [deliveryId]);
  assert.equal(opens.rows[0].n, 1, "reabrir el mismo mensaje no duplica el evento");

  // clic -> aterrizaje form -> submit con credenciales que NO deben guardarse
  const landing = await (await hop(`/t/${token}/d/${deliveryId}/go`)).text();
  assert.match(landing, /name="p"/);
  const submit = await hop(`/t/${token}/d/${deliveryId}/submit`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ u: "NO_GUARDAR", p: "TAMPOCO" }),
  });
  assert.equal(submit.status, 200);

  // finalizar -> encuesta (pregunta específica de autoridad)
  const finish = await hop(`/t/${token}/finish`, { method: "POST" });
  assert.match(finish.headers.get("location"), /\/survey$/);
  assert.match(await (await hop(`/t/${token}/survey`)).text(), /autoridad/i);

  const post = await form(`/t/${token}/survey`,
    "perceived_suspicion_before_action=false&recognized_as_simulated=false&fall_reason=confianza_remitente&vector_specific_answer=Influy%C3%B3");
  assert.match(post.headers.get("location"), /\/debrief$/);
  assert.match(await (await hop(`/t/${token}/debrief`)).text(), /simulaci[oó]n autorizada de ingenier[ií]a social/i);

  // fell_for_attack calculado de los eventos
  const s = await pool.query(
    `SELECT s.fell_for_attack FROM post_session_survey s JOIN participant_campaign pc ON pc.id = s.participant_campaign_id
     WHERE pc.access_token = $1`, [token]);
  assert.equal(s.rows[0].fell_for_attack, true);

  // dashboard por equipo refleja la caída sin exponer el hash
  const dash = await api("GET", "/api/dashboard/by-team");
  const row = dash.body.resumen_por_equipo.find((r) => r.team_label === team);
  assert.ok(row);
  assert.equal(Number(row.total_caidos), 1);
  assert.doesNotMatch(JSON.stringify(dash.body), /it_hash_/);

  // ningún evento guardó el contenido del formulario
  const ev = await pool.query(
    `SELECT * FROM events e JOIN participant_campaign pc ON pc.id = e.participant_campaign_id WHERE pc.access_token = $1`, [token]);
  const raw = JSON.stringify(ev.rows);
  assert.doesNotMatch(raw, /NO_GUARDAR/);
  assert.doesNotMatch(raw, /TAMPOCO/);

  // reenvío: clonar el mensaje y enviarlo otra vez = delivery nuevo, medición aparte
  const clone = await api("POST", `/api/messages/${msg.body.message.id}/clone`);
  assert.equal(clone.status, 201);
  const send2 = await api("POST", `/api/messages/${clone.body.message.id}/send`, { team_labels: [team] });
  assert.equal(send2.body.delivered, 1);
  const deliveries = await pool.query(
    `SELECT COUNT(*)::int n FROM deliveries d JOIN participant_campaign pc ON pc.id = d.participant_campaign_id WHERE pc.access_token = $1`, [token]);
  assert.equal(deliveries.rows[0].n, 2, "el reenvío crea un delivery independiente");
});

test("las rutas /api/* rechazan peticiones sin x-api-key", async () => {
  assert.equal((await fetch(`${baseUrl}/api/dashboard/overview`)).status, 401);
});

test("reset de participante permite volver a hacer la prueba", async () => {
  const t = await api("POST", "/api/templates", { name: `R ${Date.now()}`, vector: "urgencia", is_attack: true, subject_or_headline: "x", landing_kind: "form" });
  const c = await api("POST", "/api/campaigns", { name: `RC ${Date.now()}`, template_ids: [t.body.template.id] });
  const team = `RT ${Date.now()}`;
  const pr = await api("POST", "/api/participants/import", { participants: [{ external_hash: `r_${Date.now()}`, role: "estudiante", team_label: team }] });
  const gen = await api("POST", `/api/campaigns/${c.body.campaign.id}/generate-tokens`, { participant_ids: [pr.body.participants[0].id] });
  const token = gen.body.links[0].url.split("/").pop();
  const pcId = (await pool.query(`SELECT id FROM participant_campaign WHERE access_token = $1`, [token])).rows[0].id;

  const m = await api("POST", `/api/campaigns/${c.body.campaign.id}/messages`, { template_id: t.body.template.id });
  await api("POST", `/api/messages/${m.body.message.id}/send`, { team_labels: [team] });
  await form(`/t/${token}/consent`, "consent=1");
  await completeCalibration(token);
  const did = (await (await hop(`/t/${token}/app`)).text()).match(/\/d\/([0-9a-f-]{36})/)[1];
  await hop(`/t/${token}/d/${did}/go`);
  await hop(`/t/${token}/finish`, { method: "POST" });

  let ev = await pool.query(`SELECT COUNT(*)::int n FROM events WHERE participant_campaign_id = $1`, [pcId]);
  assert.ok(ev.rows[0].n > 0);

  const reset = await api("POST", `/api/campaigns/${c.body.campaign.id}/participants/${pcId}/reset`);
  assert.equal(reset.body.reset, 1);
  // el reset borra los eventos de interacción (abierto/clic/…) pero NO el mensaje
  ev = await pool.query(
    `SELECT COUNT(*)::int n FROM events WHERE participant_campaign_id = $1 AND event_type <> 'entregado'`, [pcId]);
  assert.equal(ev.rows[0].n, 0, "el reset borra los eventos de interacción");
  const deliv = await pool.query(`SELECT COUNT(*)::int n FROM deliveries WHERE participant_campaign_id = $1`, [pcId]);
  assert.ok(deliv.rows[0].n > 0, "el reset conserva los mensajes ya enviados");
  const pc = await pool.query(`SELECT session_started_at, finished_at, calibration_started_at, calibration_completed_at FROM participant_campaign WHERE id = $1`, [pcId]);
  assert.equal(pc.rows[0].finished_at, null);
  assert.equal(pc.rows[0].calibration_started_at, null, "el reset también hace que se repita la calibración");
  assert.equal(pc.rows[0].calibration_completed_at, null);
  // tras el reset vuelve a pedir consentimiento
  assert.match(await (await hop(`/t/${token}`)).text(), /piloto de usabilidad/i);
  // y el mensaje sigue en la bandeja al re-hacer la prueba (pasando de nuevo por la calibración)
  await form(`/t/${token}/consent`, "consent=1");
  await completeCalibration(token);
  assert.match(await (await hop(`/t/${token}/app`)).text(), /\/d\/[0-9a-f-]{36}/);
});

// Bug real encontrado en uso: un admin cargó participantes, los probó (esto
// crea el hilo de chat vacío porque todavía no había guion), y RECIÉN
// DESPUÉS armó el guion de chat en el paso 6. El guion se guardaba bien en
// la base -- pero como getOrCreateThread (lib/chat.js) solo instancia el
// guion la primera vez que se crea el hilo, nunca volvía a aparecer al
// reabrir el chat, sin ningún error visible. Este test fija ese
// comportamiento: reproduce el bug (el guion posterior no aparece) y
// confirma que "Reiniciar" (que ahora también borra el hilo, ver
// resetChatThreads en campaigns.js) es la forma de que sí se refleje.
test("un guion de chat creado después de que el participante ya abrió el chat solo se ve tras Reiniciar", async () => {
  const t = await api("POST", "/api/templates", {
    name: `ChatAtk ${Date.now()}`, vector: "curiosidad", kind: "chat", is_attack: true, channel: "web",
    sender_label: "Compañero", subject_or_headline: "Mira esto", message_body: "<p>Mira lo que encontré.</p>",
    cta_label: "Ver", landing_kind: "form",
  });
  assert.equal(t.status, 201);
  const c = await api("POST", "/api/campaigns", { name: `ChatReset ${Date.now()}` });
  const pr = await api("POST", "/api/participants/import", { participants: [{ external_hash: `cr_${Date.now()}`, role: "estudiante" }] });
  const gen = await api("POST", `/api/campaigns/${c.body.campaign.id}/generate-tokens`, { participant_ids: [pr.body.participants[0].id] });
  const token = gen.body.links[0].url.split("/").pop();
  const pcId = (await pool.query(`SELECT id FROM participant_campaign WHERE access_token = $1`, [token])).rows[0].id;

  await form(`/t/${token}/consent`, "consent=1");
  await completeCalibration(token);

  // el participante abre el chat ANTES de que exista ningún guion -> hilo vacío
  const before = await (await hop(`/t/${token}/chat.json`)).json();
  assert.equal(before.messages.length, 0);

  // el admin arma el guion recién ahora (como hizo el usuario real)
  const contact = await api("POST", `/api/campaigns/${c.body.campaign.id}/contacts`, { display_name: "Ana", role_label: "Diseño" });
  assert.equal(contact.status, 201);
  const script = await api("POST", `/api/campaigns/${c.body.campaign.id}/chat-scripts`, {
    name: "Guion tardío",
    script: [
      { type: "scripted", sender_contact_id: contact.body.contact.id, body: "¿Viste esto?" },
      { type: "attack", sender_contact_id: contact.body.contact.id, template_id: t.body.template.id },
    ],
  });
  assert.equal(script.status, 201);

  // reabrir el chat sin reiniciar: sigue vacío -- el guion nuevo no se aplicó solo
  const stillEmpty = await (await hop(`/t/${token}/chat.json`)).json();
  assert.equal(stillEmpty.messages.length, 0, "un guion creado después de instanciado el hilo no debería aparecer solo, sin reiniciar");

  // Reiniciar el participante también borra su hilo de chat
  const reset = await api("POST", `/api/campaigns/${c.body.campaign.id}/participants/${pcId}/reset`);
  assert.equal(reset.body.reset, 1);
  const threadGone = await pool.query(`SELECT COUNT(*)::int n FROM chat_threads WHERE participant_campaign_id = $1`, [pcId]);
  assert.equal(threadGone.rows[0].n, 0, "reiniciar borra el hilo de chat existente");

  // el reset también pide consentimiento de nuevo (igual que el resto de la campaña, ver test de arriba)
  await form(`/t/${token}/consent`, "consent=1");
  await completeCalibration(token);

  // al volver a abrir el chat, se re-instancia con el guion que sí existe ahora
  const after = await (await hop(`/t/${token}/chat.json`)).json();
  assert.equal(after.messages.length, 2, "tras reiniciar, el chat se arma de nuevo con el guion actual");
  assert.equal(after.messages[0].kind, "scripted");
  assert.equal(after.messages[0].body, "¿Viste esto?");
  assert.equal(after.messages[1].kind, "attack");
  assert.equal(after.messages[1].attack_template_id, t.body.template.id);
});
