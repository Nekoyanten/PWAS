// Pruebas de la biblioteca estándar de plantillas, la cobertura por equipo
// (/coverage) y las métricas ampliadas del dashboard (/overview).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db.js";
import { STANDARD_LIBRARY } from "../../src/routes/templates.js";
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
// Desde el parche de calibración (TG §9.5, paso 2): consentimiento ya no
// entra directo a /app, pasa primero por /calibration. Los tests que solo
// necesitan llegar al tablero no simulan la tarea neutra, solo marcan el
// paso como completado igual que haría el botón "Continuar" del cliente.
const completeCalibration = (token) => hop(`/t/${token}/calibration/complete`, { method: "POST" });

test("seed-defaults crea la biblioteca estándar (25 ataque + 6 relleno) y es idempotente", async () => {
  const r1 = await api("POST", "/api/templates/seed-defaults", {});
  assert.equal(r1.status, 201);
  assert.equal(r1.body.total, STANDARD_LIBRARY.length);

  assert.equal(STANDARD_LIBRARY.filter((t) => t.is_attack).length, 25);
  assert.equal(STANDARD_LIBRARY.filter((t) => t.is_attack === false).length, 6);
  // 5 por vector desde esta entrega (antes 3): al menos una en formato
  // 'chat' por vector, para que el paso 6 (Guiones de chat) tenga contenido
  // real con el que armar un guion sin que el admin tenga que escribir uno
  // desde cero.
  for (const vec of ["autoridad", "urgencia", "escasez", "prueba_social", "curiosidad"]) {
    const porVector = STANDARD_LIBRARY.filter((t) => t.is_attack && t.vector === vec);
    assert.equal(porVector.length, 5, `${vec} debería tener 5 plantillas de ataque`);
    assert.ok(porVector.some((t) => t.kind === "chat"), `${vec} debería tener al menos una plantilla 'chat directo'`);
  }

  const list = await api("GET", "/api/templates");
  const names = new Set(list.body.templates.map((t) => t.name));
  for (const d of STANDARD_LIBRARY) assert.ok(names.has(d.name), `falta la plantilla estándar: ${d.name}`);
  const vectores = new Set(STANDARD_LIBRARY.filter((t) => t.is_attack).map((t) => t.vector));
  assert.deepEqual([...vectores].sort(), ["autoridad", "curiosidad", "escasez", "prueba_social", "urgencia"]);

  const r2 = await api("POST", "/api/templates/seed-defaults", {});
  assert.ok(r2.body.templates.every((t) => t.skipped), "una segunda llamada no duplica");

  const r3 = await api("POST", "/api/templates/seed-defaults", { replace: true });
  assert.ok(r3.body.templates.every((t) => t.replaced), "con replace actualiza en vez de saltar");
});

test("/coverage refleja la técnica de ataque enviada a cada equipo", async () => {
  const stamp = Date.now();
  const c = await api("POST", "/api/campaigns", { name: `Cov ${stamp}` });
  const campId = c.body.campaign.id;
  const teamA = `A ${stamp}`, teamB = `B ${stamp}`;
  await api("POST", "/api/participants/import", { participants: [
    { external_hash: `cov_a_${stamp}`, role: "estudiante", team_label: teamA },
    { external_hash: `cov_b_${stamp}`, role: "profesor", team_label: teamB },
  ] });
  await api("POST", `/api/campaigns/${campId}/generate-tokens`, {});

  const mkAttack = async (vector) => {
    const m = await api("POST", `/api/campaigns/${campId}/messages`, {
      is_attack: true, vector, kind: "email", subject: `atk ${vector} ${stamp}`, landing_kind: "form",
    });
    return m.body.message.id;
  };
  await api("POST", `/api/messages/${await mkAttack("autoridad")}/send`, { team_labels: [teamA] });
  await api("POST", `/api/messages/${await mkAttack("urgencia")}/send`, { team_labels: [teamB] });

  const cov = await api("GET", `/api/campaigns/${campId}/coverage`);
  assert.equal(cov.status, 200);
  const a = cov.body.teams.find((t) => t.team_label === teamA);
  const b = cov.body.teams.find((t) => t.team_label === teamB);
  assert.deepEqual(a.ataques.map((x) => x.vector), ["autoridad"]);
  assert.deepEqual(b.ataques.map((x) => x.vector), ["urgencia"]);
  assert.doesNotMatch(JSON.stringify(cov.body), /cov_a_|cov_b_/, "coverage no expone external_hash");
});

test("/overview incluye embudo, por_tecnica, por_rol y percepcion", async () => {
  const stamp = Date.now();
  const c = await api("POST", "/api/campaigns", { name: `Ov ${stamp}` });
  const campId = c.body.campaign.id;
  const team = `OT ${stamp}`;
  await api("POST", "/api/participants/import", { participants: [{ external_hash: `ov_${stamp}`, role: "directivo", team_label: team }] });
  await api("POST", `/api/campaigns/${campId}/generate-tokens`, {});
  const m = await api("POST", `/api/campaigns/${campId}/messages`, { is_attack: true, vector: "escasez", kind: "email", subject: `ov atk ${stamp}`, landing_kind: "form" });
  await api("POST", `/api/messages/${m.body.message.id}/send`, { team_labels: [team] });

  const token = (await pool.query(`SELECT access_token FROM participant_campaign pc JOIN participants p ON p.id = pc.participant_id WHERE p.external_hash = $1`, [`ov_${stamp}`])).rows[0].access_token;
  // TG §9.1: el consentimiento de cámara del sub-estudio facial es una
  // casilla separada del consentimiento general -- se marca aquí también
  // para poder verificar que /overview la cuenta como subconjunto, no como
  // un total aparte (§9.2/§9.6).
  await form(`/t/${token}/consent`, "consent=1&camera_consent=1");
  await completeCalibration(token);
  const did = (await (await hop(`/t/${token}/app`)).text()).match(/\/d\/([0-9a-f-]{36})/)[1];
  await hop(`/t/${token}/d/${did}/go`);
  await hop(`/t/${token}/d/${did}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await hop(`/t/${token}/finish`, { method: "POST" });
  await form(`/t/${token}/survey`, "perceived_suspicion_before_action=false&recognized_as_simulated=true&fall_reason=promesa_beneficio");

  const ov = await api("GET", "/api/dashboard/overview");
  assert.equal(ov.status, 200);
  for (const k of ["embudo", "por_tecnica", "por_rol", "percepcion"]) assert.ok(ov.body[k], `falta ${k}`);
  assert.ok(Number(ov.body.embudo.recibieron) >= 1);
  assert.ok(Number(ov.body.embudo.cayeron) >= 1);
  const esc = ov.body.por_tecnica.find((r) => r.clave === "escasez");
  assert.ok(esc && Number(esc.cayeron) >= 1);
  assert.ok(ov.body.por_rol.some((r) => r.clave === "directivo"));
  assert.doesNotMatch(JSON.stringify(ov.body), /ov_[0-9]{10,}/, "overview no expone external_hash");
  // TG §9.2/§9.6: total_consentimiento_camara es un SUBCONJUNTO de
  // total_expuestos (el núcleo de Fase 1), nunca mayor que él -- así el
  // panel no puede, por construcción, sugerir un universo aparte para el
  // sub-estudio facial.
  assert.ok(Number(ov.body.totales.total_consentimiento_camara) >= 1);
  assert.ok(Number(ov.body.totales.total_consentimiento_camara) <= Number(ov.body.totales.total_expuestos));
});
