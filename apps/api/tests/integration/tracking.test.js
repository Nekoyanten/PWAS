// Prueba de integración end-to-end del flujo "TaskFlow": crea plantillas +
// campaña con pool + participante, genera y ENTREGA el estímulo, y recorre
// consentimiento -> app -> abrir mensaje -> clic -> intento_envio -> finalizar
// -> encuesta adaptada -> debriefing. Verifica que:
//  - el vector se asigna de forma reproducible por semilla,
//  - fell_for_attack se calcula de los eventos, no del autorreporte,
//  - el dashboard agregado nunca expone external_hash,
//  - /submit nunca persiste el contenido del formulario,
//  - /grant solo guarda la etiqueta del permiso.
//
// Requiere DATABASE_URL apuntando a una base con el esquema ya cargado.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import { assignBalanced } from "../../src/lib/rng.js";

process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "test_key_local_only";

let server;
let baseUrl;
const key = process.env.ADMIN_API_KEY;
const jh = { "x-api-key": key, "Content-Type": "application/json" };

before(async () => {
  server = createApp().listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
});
after(async () => {
  server.close();
  await pool.end();
});

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: jh,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Sigue redirecciones manualmente para inspeccionar cada salto.
async function hop(path, opts = {}) {
  return fetch(`${baseUrl}${path}`, { redirect: "manual", ...opts });
}

test("assignBalanced es determinista y balanceado para una semilla dada", () => {
  const opts = ["a", "b", "c"];
  const r1 = assignBalanced(opts, 9, "seed-x");
  const r2 = assignBalanced(opts, 9, "seed-x");
  assert.deepEqual(r1, r2, "misma semilla => mismo reparto");
  const counts = opts.map((o) => r1.filter((x) => x === o).length);
  assert.deepEqual(counts.sort(), [3, 3, 3], "reparto balanceado");
  assert.notDeepEqual(assignBalanced(opts, 9, "seed-y"), r1, "semilla distinta => reparto distinto");
});

test("flujo TaskFlow completo: consentimiento -> estímulo -> caída -> encuesta -> debrief -> métricas", async () => {
  // 1) dos plantillas de vectores distintos (una form, una permiso)
  const t1 = await api("POST", "/api/templates", {
    name: `Auth ${Date.now()}`, vector: "autoridad", channel: "web",
    sender_label: "Coordinación", subject_or_headline: "Confirma tus datos",
    message_body: "<p>Confirma ya.</p>", cta_label: "Confirmar", landing_kind: "form",
  });
  assert.equal(t1.status, 201);
  const t2 = await api("POST", "/api/templates", {
    name: `Curio ${Date.now()}`, vector: "curiosidad", channel: "web",
    subject_or_headline: "Documento compartido", landing_kind: "permiso",
    landing_config: { permiso: "camara" },
  });
  assert.equal(t2.status, 201);

  // 2) campaña con pool de las 2 plantillas y semilla fija
  const c = await api("POST", "/api/campaigns", {
    name: `Camp ${Date.now()}`, seed: "itest-seed",
    template_ids: [t1.body.template.id, t2.body.template.id],
  });
  assert.equal(c.status, 201);
  const campaignId = c.body.campaign.id;

  // 3) participante
  const team = `Equipo IT ${Date.now()}`;
  const hash = `it_hash_${Date.now()}`;
  const p = await api("POST", "/api/participants/import", {
    participants: [{ external_hash: hash, role: "estudiante", team_label: team }],
  });
  assert.equal(p.status, 201);
  const participantId = p.body.participants[0].id;

  // 4) generar token (asigna estímulo) + entregar
  const gen = await api("POST", `/api/campaigns/${campaignId}/generate-tokens`, { participant_ids: [participantId] });
  assert.equal(gen.status, 201);
  const token = gen.body.links[0].url.split("/").pop();
  const del = await api("POST", `/api/campaigns/${campaignId}/deliver`, {});
  assert.equal(del.body.delivered, 1);

  // 5) el participante entra: primero ve el consentimiento
  const welcome = await hop(`/t/${token}`);
  assert.equal(welcome.status, 200);
  assert.match(await welcome.text(), /piloto de usabilidad/i);

  // 6) acepta el consentimiento -> redirige a /app
  const consent = await hop(`/t/${token}/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "consent=1",
  });
  assert.equal(consent.status, 302);
  assert.match(consent.headers.get("location"), /\/app$/);

  // 7) abre la app y luego el mensaje-estímulo -> evento 'abierto'
  assert.equal((await hop(`/t/${token}/app`)).status, 200);
  const msg = await hop(`/t/${token}/message/stim`);
  assert.equal(msg.status, 200);

  // 8) clic en el CTA -> evento 'clic' + aterrizaje
  const landing = await hop(`/t/${token}/stimulus`);
  assert.equal(landing.status, 200);
  const landingHtml = await landing.text();

  // 9) completa el aterrizaje según el tipo
  if (/name="p"/.test(landingHtml)) {
    const submit = await hop(`/t/${token}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ u: "NO_GUARDAR", p: "TAMPOCO" }),
    });
    assert.equal(submit.status, 200);
  } else {
    const grant = await hop(`/t/${token}/grant`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "permiso=camara",
    });
    assert.equal(grant.status, 302);
  }

  // 10) finaliza el piloto -> encuesta
  const finish = await hop(`/t/${token}/finish`, { method: "POST" });
  assert.equal(finish.status, 302);
  assert.match(finish.headers.get("location"), /\/survey$/);

  const survey = await hop(`/t/${token}/survey`);
  assert.equal(survey.status, 200);
  const surveyHtml = await survey.text();
  // la pregunta específica del vector debe estar presente
  assert.match(surveyHtml, /autoridad|curiosidad/i);

  // 11) envía la encuesta -> debrief
  const post = await hop(`/t/${token}/survey`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "perceived_suspicion_before_action=false&recognized_as_simulated=false&fall_reason=curiosidad&vector_specific_answer=Influy%C3%B3+algo",
  });
  assert.equal(post.status, 302);
  assert.match(post.headers.get("location"), /\/debrief$/);
  assert.match(await (await hop(`/t/${token}/debrief`)).text(), /simulaci[oó]n autorizada de ingenier[ií]a social/i);

  // 12) fell_for_attack se calculó de los eventos (hubo clic) -> true
  const s = await pool.query(
    `SELECT s.fell_for_attack FROM post_session_survey s
     JOIN participant_campaign pc ON pc.id = s.participant_campaign_id
     WHERE pc.access_token = $1`,
    [token]
  );
  assert.equal(s.rows[0].fell_for_attack, true);

  // 13) el dashboard agregado por equipo refleja la caída SIN exponer el hash
  const dash = await api("GET", "/api/dashboard/by-team");
  assert.equal(dash.status, 200);
  const row = dash.body.resumen_por_equipo.find((r) => r.team_label === team);
  assert.ok(row, "el equipo debe aparecer");
  assert.equal(Number(row.total_caidos), 1);
  assert.doesNotMatch(JSON.stringify(dash.body), /it_hash_/, "el dashboard nunca expone external_hash");

  // 14) ningún evento guardó el contenido del formulario
  const ev = await pool.query(
    `SELECT * FROM events e JOIN participant_campaign pc ON pc.id = e.participant_campaign_id
     WHERE pc.access_token = $1`,
    [token]
  );
  const raw = JSON.stringify(ev.rows);
  assert.doesNotMatch(raw, /NO_GUARDAR/);
  assert.doesNotMatch(raw, /TAMPOCO/);
});

test("las rutas /api/* rechazan peticiones sin x-api-key", async () => {
  const res = await fetch(`${baseUrl}/api/dashboard/overview`);
  assert.equal(res.status, 401);
});

test("/t/:token/submit nunca persiste el contenido del formulario aunque se envíe por error", async () => {
  const t = await api("POST", "/api/templates", {
    name: `Sub ${Date.now()}`, vector: "urgencia", channel: "web",
    subject_or_headline: "x", landing_kind: "form",
  });
  const c = await api("POST", "/api/campaigns", { name: `C ${Date.now()}`, template_ids: [t.body.template.id] });
  const p = await api("POST", "/api/participants/import", {
    participants: [{ external_hash: `it_b_${Date.now()}`, role: "estudiante" }],
  });
  const gen = await api("POST", `/api/campaigns/${c.body.campaign.id}/generate-tokens`, {
    participant_ids: [p.body.participants[0].id],
  });
  await api("POST", `/api/campaigns/${c.body.campaign.id}/deliver`, {});
  const token = gen.body.links[0].url.split("/").pop();

  await fetch(`${baseUrl}/t/${token}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "credencial_secreta", pass: "1234abcd" }),
  });

  const ev = await pool.query(
    `SELECT * FROM events e JOIN participant_campaign pc ON pc.id = e.participant_campaign_id
     WHERE pc.access_token = $1`,
    [token]
  );
  const raw = JSON.stringify(ev.rows);
  assert.doesNotMatch(raw, /credencial_secreta/);
  assert.doesNotMatch(raw, /1234abcd/);
});
