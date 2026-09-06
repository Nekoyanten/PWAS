// Prueba de integración de la asignación balanceada de grupo (TG §9.2):
// POST /api/campaigns/:id/assign-groups.
//
// Contexto: `participants.group_assignment` (control/experimental) existía
// desde el inicio del esquema y ya lo lee la intervención PAWS (ver
// intervention.test.js), pero hasta ahora solo se podía fijar a mano al
// importar participantes — no había ningún endpoint que lo asignara de forma
// aleatoria y balanceada. Este endpoint reutiliza `assignBalanced` (lib/
// rng.js), el mismo mecanismo que ya reparte el vector de ataque por equipo
// (GET /:id/plan), para repartir el grupo.
//
// Verifica que:
//  - reparte balanceado (diferencia máxima de 1) y reproducible (misma
//    semilla de campaña -> mismo reparto) entre los participantes de la
//    campaña;
//  - por defecto NUNCA pisa un group_assignment ya puesto a mano (import
//    CSV/JSON) — solo llena los que están en NULL;
//  - con `force:true` sí reasigna a quienes ya tenían grupo... salvo que su
//    sesión en esta campaña ya haya empezado (GET /app), a quienes protege
//    siempre, con o sin force — cambiarles el grupo después de eso
//    invalidaría los datos que ya se estén recolectando;
//  - no toca participantes de otra campaña ni el pool general de
//    `participants` fuera de esta campaña;
//  - exige x-api-key, igual que el resto de /api/campaigns;
//  - 404 si la campaña no existe.
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

// Crea una campaña con semilla fija y N participantes sin group_assignment,
// los suscribe (genera enlaces) y devuelve { campaignId, participantIds,
// tokens }, en el mismo orden en que el endpoint los va a ordenar (por
// p.id) — se obtiene consultando /links después de generar los tokens.
async function setupCampaign(stamp, n, { seed } = {}) {
  const c = await api("POST", "/api/campaigns", { name: `Grp ${stamp}`, seed: seed ?? `seed_${stamp}` });
  const campaignId = c.body.campaign.id;
  const participants = Array.from({ length: n }, (_, i) => ({
    external_hash: `grp_${stamp}_${i}`, role: "estudiante", team_label: `EquipoGrp ${stamp}`,
  }));
  const imp = await api("POST", "/api/participants/import", { participants });
  const participantIds = imp.body.participants.map((p) => p.id);
  // OJO: generate-tokens SIN participant_ids vincula a la campaña TODO
  // participante del pool global que aún no tenga enlace en ella (así está
  // pensado para el caso real de "importar una vez, generar para todos") —
  // en un test eso arrastraría participantes de otras pruebas que comparten
  // la misma base. Se pasa participant_ids explícito para aislar cada test.
  await api("POST", `/api/campaigns/${campaignId}/generate-tokens`, { participant_ids: participantIds });
  return { campaignId, participantIds };
}

async function groupsOf(participantIds) {
  const r = await pool.query(`SELECT id, group_assignment FROM participants WHERE id = ANY($1::uuid[])`, [participantIds]);
  const byId = new Map(r.rows.map((row) => [row.id, row.group_assignment]));
  return participantIds.map((id) => byId.get(id));
}

test("reparte balanceado (±1) entre los participantes de la campaña", async () => {
  const stamp = Date.now();
  const { campaignId, participantIds } = await setupCampaign(stamp, 11);

  const res = await api("POST", `/api/campaigns/${campaignId}/assign-groups`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.asignados, 11);
  assert.equal(res.body.omitidos_ya_asignados, 0);
  assert.equal(res.body.omitidos_por_sesion_iniciada, 0);
  assert.equal(res.body.resumen.control + res.body.resumen.experimental, 11);
  assert.ok(Math.abs(res.body.resumen.control - res.body.resumen.experimental) <= 1, JSON.stringify(res.body.resumen));

  const groups = await groupsOf(participantIds);
  assert.ok(groups.every((g) => g === "control" || g === "experimental"), "todos quedaron con un grupo válido");
  const control = groups.filter((g) => g === "control").length;
  assert.equal(control, res.body.resumen.control, "el conteo reportado coincide con lo guardado en la base");
});

test("misma semilla de campaña -> mismo reparto exacto (reproducible)", async () => {
  const stamp = Date.now();
  const { campaignId: c1, participantIds: p1 } = await setupCampaign(`${stamp}a`, 12, { seed: "semilla-fija-repro" });
  const { campaignId: c2, participantIds: p2 } = await setupCampaign(`${stamp}b`, 12, { seed: "semilla-fija-repro" });

  await api("POST", `/api/campaigns/${c1}/assign-groups`, {});
  await api("POST", `/api/campaigns/${c2}/assign-groups`, {});

  const g1 = await groupsOf(p1);
  const g2 = await groupsOf(p2);
  // Dos campañas DISTINTAS con la MISMA semilla de campaña deliberadamente NO
  // deben coincidir (el campaignId entra también en la semilla de rng.js, ver
  // campaigns.js) — si coincidieran indicaría que el campaignId no se está
  // mezclando y dos campañas con la misma semilla producirían siempre el
  // mismo reparto, algo que sí sería un bug de diseño.
  assert.notDeepEqual(g1, g2, "campaignId debe des-correlacionar el reparto aunque la semilla sea igual");

  // Pero llamar DOS VECES sobre la MISMA campaña con force:true (sin que
  // nadie haya empezado sesión) sí debe dar exactamente el mismo resultado.
  await api("POST", `/api/campaigns/${c1}/assign-groups`, { force: true });
  const g1repeat = await groupsOf(p1);
  assert.deepEqual(g1, g1repeat, "re-ejecutar con force:true sobre la misma campaña es determinista");
});

test("por defecto no pisa un group_assignment puesto a mano; solo llena los NULL", async () => {
  const stamp = Date.now();
  const c = await api("POST", "/api/campaigns", { name: `GrpManual ${stamp}`, seed: `seed_${stamp}` });
  const campaignId = c.body.campaign.id;
  const imp = await api("POST", "/api/participants/import", {
    participants: [
      { external_hash: `grpm_${stamp}_0`, role: "estudiante", team_label: "T", group_assignment: "control" },
      { external_hash: `grpm_${stamp}_1`, role: "estudiante", team_label: "T" }, // sin grupo
      { external_hash: `grpm_${stamp}_2`, role: "estudiante", team_label: "T" }, // sin grupo
    ],
  });
  const ids = imp.body.participants.map((p) => p.id);
  await api("POST", `/api/campaigns/${campaignId}/generate-tokens`, { participant_ids: ids });

  const res = await api("POST", `/api/campaigns/${campaignId}/assign-groups`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.asignados, 2, "solo los 2 sin grupo se asignan");
  assert.equal(res.body.omitidos_ya_asignados, 1);

  const groups = await groupsOf(ids);
  assert.equal(groups[0], "control", "el que ya tenía grupo manual no cambió");
  assert.ok(groups[1] && groups[2], "los que estaban en NULL ya tienen un grupo asignado");
});

test("force:true reasigna a quienes ya tenían grupo, pero nunca a quien ya empezó su sesión", async () => {
  const stamp = Date.now();
  const c = await api("POST", "/api/campaigns", { name: `GrpForce ${stamp}`, seed: `seed_${stamp}` });
  const campaignId = c.body.campaign.id;
  const imp = await api("POST", "/api/participants/import", {
    participants: [
      { external_hash: `grpf_${stamp}_0`, role: "estudiante", team_label: "T", group_assignment: "experimental" },
      { external_hash: `grpf_${stamp}_1`, role: "estudiante", team_label: "T", group_assignment: "control" },
    ],
  });
  const ids = imp.body.participants.map((p) => p.id);
  const gen = await api("POST", `/api/campaigns/${campaignId}/generate-tokens`, { participant_ids: ids });

  // El primer participante YA empieza su sesión de verdad (consiente, pasa
  // la calibración, y abre /app) antes de que se corra la reasignación.
  const tokenStarted = gen.body.links[0].url.split("/").pop();
  await form(`/t/${tokenStarted}/consent`, "consent=1");
  await completeCalibration(tokenStarted);
  const appRes = await hop(`/t/${tokenStarted}/app`);
  assert.equal(appRes.status, 200, "la sesión del primer participante sí arrancó de verdad");

  const before = await groupsOf(ids);
  const res = await api("POST", `/api/campaigns/${campaignId}/assign-groups`, { force: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.omitidos_por_sesion_iniciada, 1, "el que ya empezó sesión queda protegido");
  assert.equal(res.body.asignados, 1, "solo se reasigna el que no había empezado");

  const after = await groupsOf(ids);
  assert.equal(after[0], before[0], "el grupo del participante que ya empezó sesión NO cambió, aunque force:true");
});

test("no toca participantes de otra campaña", async () => {
  const stamp = Date.now();
  const { campaignId: c1, participantIds: p1 } = await setupCampaign(`${stamp}x`, 3);
  const { participantIds: p2 } = await setupCampaign(`${stamp}y`, 3);

  await api("POST", `/api/campaigns/${c1}/assign-groups`, {});

  const groupsC1 = await groupsOf(p1);
  const groupsC2 = await groupsOf(p2);
  assert.ok(groupsC1.every((g) => g !== null), "la campaña asignada sí quedó con grupos");
  assert.ok(groupsC2.every((g) => g === null), "la otra campaña, nunca tocada, sigue en NULL");
});

test("responde asignados:0 sin romper si ya no queda nadie por asignar", async () => {
  const stamp = Date.now();
  const { campaignId } = await setupCampaign(stamp, 3);
  await api("POST", `/api/campaigns/${campaignId}/assign-groups`, {});
  const res2 = await api("POST", `/api/campaigns/${campaignId}/assign-groups`, {});
  assert.equal(res2.status, 200);
  assert.equal(res2.body.asignados, 0);
  assert.equal(res2.body.omitidos_ya_asignados, 3);
});

test("404 si la campaña no existe", async () => {
  const res = await api("POST", `/api/campaigns/00000000-0000-0000-0000-000000000000/assign-groups`, {});
  assert.equal(res.status, 404);
});

test("exige x-api-key (mismo criterio que el resto de /api/campaigns)", async () => {
  const stamp = Date.now();
  const { campaignId } = await setupCampaign(stamp, 2);
  const res = await fetch(`${baseUrl}/api/campaigns/${campaignId}/assign-groups`, { method: "POST" });
  assert.equal(res.status, 401);
});
