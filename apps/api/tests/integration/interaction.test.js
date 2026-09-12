// Prueba de integración del módulo de interacción ampliada (migración 010):
// compañeros ficticios, tableros reales con tareas asignables, chat
// persistente con guion (scripted + ataque inyectado), árbol de respuestas
// (branching) sobre correo y sobre chat, y coincidencia de credenciales de
// práctica. Mismas convenciones que tracking.test.js: Postgres real, server
// HTTP real, sin mocks.
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

before(async () => { server = createApp().listen(0); baseUrl = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await cleanupTestData(); await pool.end(); });

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: jh, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const hop = (path, opts = {}) => fetch(`${baseUrl}${path}`, { redirect: "manual", ...opts });
const completeCalibration = (token) => hop(`/t/${token}/calibration/complete`, { method: "POST" });

// Helper: campaña + participante + token, ya con consentimiento y
// calibración completados (listo para llegar a /app y a las rutas nuevas).
async function makeParticipant(campaignId, teamLabel) {
  const hash = `hash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const p = await api("POST", "/api/participants/import", {
    participants: [{ external_hash: hash, role: "estudiante", team_label: teamLabel }],
  });
  assert.equal(p.status, 201);
  const gen = await api("POST", `/api/campaigns/${campaignId}/generate-tokens`, { participant_ids: [p.body.participants[0].id] });
  assert.equal(gen.status, 201);
  const token = gen.body.links[0].url.split("/").pop();
  await hop(`/t/${token}/consent`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "consent=1" });
  await completeCalibration(token);
  const pcRow = await pool.query(`SELECT id FROM participant_campaign WHERE access_token = $1`, [token]);
  return { token, pcId: pcRow.rows[0].id };
}

test("compañeros ficticios: CRUD y borrado bloqueado si están en uso", async () => {
  const c = await api("POST", "/api/campaigns", { name: `Camp ${Date.now()}` });
  assert.equal(c.status, 201);
  const campaignId = c.body.campaign.id;

  const created = await api("POST", `/api/campaigns/${campaignId}/contacts`, {
    display_name: "Marcela Ruiz", role_label: "Líder de proyecto", avatar_color: "#4f46e5",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.contact.display_name, "Marcela Ruiz");

  const missingName = await api("POST", `/api/campaigns/${campaignId}/contacts`, {});
  assert.equal(missingName.status, 400);

  const list = await api("GET", `/api/campaigns/${campaignId}/contacts`);
  assert.equal(list.status, 200);
  assert.equal(list.body.contacts.length, 1);

  // usarlo en una tarea antes de intentar borrarlo
  const p = await makeParticipant(campaignId, `T ${Date.now()}`);
  const board = await hop(`/t/${p.token}/boards`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Tablero de prueba" }),
  });
  const boardBody = await board.json();
  const col = boardBody.board ? (await (await hop(`/t/${p.token}/boards.json`)).json()).boards[0].columns[0] : null;
  await hop(`/t/${p.token}/boards/${boardBody.board.id}/tasks`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ column_id: col.id, title: "Tarea con responsable", responsible_contact_id: created.body.contact.id }),
  });

  const blocked = await api("DELETE", `/api/contacts/${created.body.contact.id}`);
  assert.equal(blocked.status, 409, "no se puede borrar un contacto en uso");

  const other = await api("POST", `/api/campaigns/${campaignId}/contacts`, { display_name: "Sin usar" });
  const freeDelete = await api("DELETE", `/api/contacts/${other.body.contact.id}`);
  assert.equal(freeDelete.status, 200);
});

test("plantillas de tablero: validación de forma del seed y clonado al crear tablero", async () => {
  const c = await api("POST", "/api/campaigns", { name: `Camp ${Date.now()}` });
  const campaignId = c.body.campaign.id;
  const contact = await api("POST", `/api/campaigns/${campaignId}/contacts`, { display_name: "Diego Peña" });

  const badSeed = await api("POST", `/api/campaigns/${campaignId}/board-templates`, { name: "x", seed: [{ tasks: [] }] });
  assert.equal(badSeed.status, 400, "columna sin 'name' debe rechazarse");

  const tpl = await api("POST", `/api/campaigns/${campaignId}/board-templates`, {
    name: "Desarrollo de aplicativo verde",
    seed: [
      { name: "Por hacer", tasks: [{ title: "Definir alcance", description: "Reunión inicial", responsible_contact_id: contact.body.contact.id }] },
      { name: "En curso", tasks: [] },
      { name: "Hecho", tasks: [] },
    ],
  });
  assert.equal(tpl.status, 201);

  const p = await makeParticipant(campaignId, `T ${Date.now()}`);
  const created = await hop(`/t/${p.token}/boards`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Mi tablero verde", template_id: tpl.body.board_template.id }),
  });
  assert.equal(created.status, 201);

  const loaded = await (await hop(`/t/${p.token}/boards.json`)).json();
  assert.equal(loaded.boards.length, 1);
  assert.equal(loaded.boards[0].columns.length, 3);
  const porHacer = loaded.boards[0].columns.find((col) => col.name === "Por hacer");
  assert.equal(porHacer.tasks.length, 1);
  assert.equal(porHacer.tasks[0].responsible_contact_id, contact.body.contact.id);
  assert.equal(porHacer.tasks[0].responsible_name, "Diego Peña", "el nombre del responsable viene de fictitious_contacts, no de texto libre");
});

test("tableros del participante: crear, agregar/editar/mover/borrar tareas, y aislamiento entre participantes", async () => {
  const c = await api("POST", "/api/campaigns", { name: `Camp ${Date.now()}` });
  const campaignId = c.body.campaign.id;
  const contact = await api("POST", `/api/campaigns/${campaignId}/contacts`, { display_name: "Sofía Londoño", role_label: "Marketing" });

  const a = await makeParticipant(campaignId, `TA ${Date.now()}`);
  const b = await makeParticipant(campaignId, `TB ${Date.now()}`);

  // participante A crea dos tableros, como en el ejemplo del usuario
  const board1 = await (await hop(`/t/${a.token}/boards`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Desarrollo de aplicativo verde" }),
  })).json();
  const board2 = await (await hop(`/t/${a.token}/boards`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Marketing digital" }),
  })).json();
  assert.notEqual(board1.board.id, board2.board.id);

  const listA = await (await hop(`/t/${a.token}/boards.json`)).json();
  assert.equal(listA.boards.length, 2);
  const col1 = listA.boards.find((x) => x.id === board1.board.id).columns[0];

  // agregar tarea con responsable
  const addRes = await hop(`/t/${a.token}/boards/${board1.board.id}/tasks`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ column_id: col1.id, title: "Preparar entorno", description: "Instalar dependencias", responsible_contact_id: contact.body.contact.id }),
  });
  assert.equal(addRes.status, 201);
  const task = (await addRes.json()).task;

  // editar título/descripción/responsable
  const editRes = await hop(`/t/${a.token}/boards/${board1.board.id}/tasks/${task.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Preparar entorno de desarrollo", description: "Node + Postgres" }),
  });
  assert.equal(editRes.status, 200);
  assert.equal((await editRes.json()).task.title, "Preparar entorno de desarrollo");

  // mover a otra columna del mismo tablero
  const listA2 = await (await hop(`/t/${a.token}/boards.json`)).json();
  const boardAfter = listA2.boards.find((x) => x.id === board1.board.id);
  const targetCol = boardAfter.columns.find((col) => col.id !== col1.id);
  const moveRes = await hop(`/t/${a.token}/boards/${board1.board.id}/tasks/${task.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ column_id: targetCol.id }),
  });
  assert.equal(moveRes.status, 200);

  // mover a una columna de OTRO tablero (mismo participante) debe rechazarse
  const col2 = listA2.boards.find((x) => x.id === board2.board.id).columns[0];
  const crossBoardMove = await hop(`/t/${a.token}/boards/${board1.board.id}/tasks/${task.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ column_id: col2.id }),
  });
  assert.equal(crossBoardMove.status, 400, "no se puede mover una tarea a una columna de otro tablero");

  // el participante B no puede ver ni tocar los tableros de A (ownership)
  const bTriesRead = await (await hop(`/t/${b.token}/boards.json`)).json();
  assert.equal(bTriesRead.boards.length, 0);
  const bTriesAdd = await hop(`/t/${b.token}/boards/${board1.board.id}/tasks`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ column_id: col1.id, title: "Intento ajeno" }),
  });
  assert.equal(bTriesAdd.status, 404, "un tablero ajeno (id adivinado) no debe ser editable");
  const bTriesDelete = await hop(`/t/${a.token.slice(0, -1) + (a.token.slice(-1) === "0" ? "1" : "0")}/boards/${board1.board.id}/tasks/${task.id}`, { method: "DELETE" });
  assert.ok(bTriesDelete.status === 404 || bTriesDelete.status === 200, "token corrupto: no debe 500");

  // borrar la tarea
  const delRes = await hop(`/t/${a.token}/boards/${board1.board.id}/tasks/${task.id}`, { method: "DELETE" });
  assert.equal(delRes.status, 200);
  const finalList = await (await hop(`/t/${a.token}/boards.json`)).json();
  const finalBoard1 = finalList.boards.find((x) => x.id === board1.board.id);
  const remaining = finalBoard1.columns.flatMap((col) => col.tasks);
  assert.equal(remaining.length, 0);
});

test("chat: instanciación de guion (scripted + ataque), respuesta libre y árbol de respuestas continúa en el mismo hilo", async () => {
  const c = await api("POST", "/api/campaigns", { name: `Camp ${Date.now()}` });
  const campaignId = c.body.campaign.id;
  const contact = await api("POST", `/api/campaigns/${campaignId}/contacts`, { display_name: "Andrés Gómez", role_label: "Compañero de equipo" });
  const senderId = contact.body.contact.id;

  // El "kind" de la PLANTILLA (email|task|chat) no importa para un ataque de
  // chat: chat.js fija message.kind='chat' directamente al instanciar el
  // guion, sin copiarlo de la plantilla (ver lib/chat.js) -- por eso estas
  // dos plantillas de prueba se crean con su kind por defecto ('email') y
  // aun así terminan entregándose por chat. Que /api/templates SÍ acepte
  // kind='chat' para etiquetar una plantilla como "de chat directo" se
  // prueba aparte, más abajo.
  const t1 = await api("POST", "/api/templates", {
    name: `Auth ${Date.now()}`, vector: "autoridad", is_attack: true, channel: "web",
    sender_label: "Andrés Gómez", subject_or_headline: "Necesito que confirmes el acceso",
    message_body: "Oye, ¿puedes confirmar tus credenciales del portal? Nos las pide sistemas.",
    cta_label: "Confirmar acceso", landing_kind: "form",
  });
  const t2 = await api("POST", "/api/templates", {
    name: `Auth ${Date.now() + 1}`, vector: "urgencia", is_attack: true, channel: "web",
    sender_label: "Andrés Gómez", subject_or_headline: "Es urgente, necesito eso ya",
    message_body: "El equipo de sistemas está esperando, por favor confírmalo antes de la reunión.",
    cta_label: "Confirmar ahora", landing_kind: "form",
  });
  assert.equal(t1.status, 201);
  assert.equal(t2.status, 201);

  const branch = await api("POST", `/api/templates/${t1.body.template.id}/branches`, {
    action_key: "no_puedo_ahora", action_label: "Ahora no puedo, ¿es urgente?", to_template_id: t2.body.template.id,
  });
  assert.equal(branch.status, 201);

  await api("POST", `/api/campaigns/${campaignId}/chat-scripts`, {
    name: "Guion base",
    script: [
      { type: "scripted", sender_contact_id: senderId, body: "Hola, ¿cómo vas con lo de esta semana?" },
      { type: "attack", template_id: t1.body.template.id, sender_contact_id: senderId },
    ],
  });

  const defaultScript = await api("GET", `/api/campaigns/${campaignId}/chat-scripts/default`);
  assert.equal(defaultScript.status, 200);
  assert.ok(defaultScript.body.chat_script);

  const p = await makeParticipant(campaignId, `T ${Date.now()}`);

  // primera carga del chat instancia el guion
  const chatJson1 = await (await hop(`/t/${p.token}/chat.json`)).json();
  assert.equal(chatJson1.messages.length, 2);
  assert.equal(chatJson1.messages[0].kind, "scripted");
  assert.equal(chatJson1.messages[0].body, "Hola, ¿cómo vas con lo de esta semana?");
  assert.equal(chatJson1.messages[1].kind, "attack");
  assert.ok(chatJson1.messages[1].delivery_id);
  const deliveryId = chatJson1.messages[1].delivery_id;

  // el chat en sí (no solo la tarjeta de bandeja) trae las ramas del árbol
  // de respuestas de este ataque, para poder ofrecer los botones de
  // respuesta rápida sin que el participante tenga que salir del hilo.
  assert.equal(chatJson1.messages[1].branches.length, 1);
  assert.equal(chatJson1.messages[1].branches[0].action_key, "no_puedo_ahora");

  // se creó de verdad el message+delivery+evento 'entregado' (misma tubería que un correo)
  const deliveredEvent = await pool.query(`SELECT 1 FROM events WHERE delivery_id = $1 AND event_type = 'entregado'`, [deliveryId]);
  assert.equal(deliveredEvent.rows.length, 1);

  // volver a cargar no duplica el guion (se instancia una sola vez)
  const chatJson2 = await (await hop(`/t/${p.token}/chat.json`)).json();
  assert.equal(chatJson2.messages.length, 2);

  // respuesta libre del participante
  const replyRes = await hop(`/t/${p.token}/chat/reply`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "Voy bien, gracias" }),
  });
  assert.equal(replyRes.status, 201);
  const afterReply = await (await hop(`/t/${p.token}/chat.json`)).json();
  assert.equal(afterReply.messages.length, 3);
  assert.equal(afterReply.messages[2].kind, "reply");
  assert.equal(afterReply.messages[2].body, "Voy bien, gracias");
  const freeReplyEvent = await pool.query(
    `SELECT 1 FROM events WHERE participant_campaign_id = $1 AND event_type = 'respuesta_participante' AND detail = 'chat_libre'`, [p.pcId]
  );
  assert.equal(freeReplyEvent.rows.length, 1);

  // seguir la rama del árbol de respuestas sobre el ataque de chat
  const branchRes = await hop(`/t/${p.token}/d/${deliveryId}/branch`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action_key: "no_puedo_ahora" }),
  });
  assert.equal(branchRes.status, 201);
  const branchBody = await branchRes.json();
  assert.equal(branchBody.appended_to_chat, true);
  assert.equal(branchBody.message.parent_message_id, chatJson1.messages[1].attack_message_id);
  assert.equal(branchBody.message.branch_action_key, "no_puedo_ahora");

  const finalChat = await (await hop(`/t/${p.token}/chat.json`)).json();
  assert.equal(finalChat.messages.length, 4, "el siguiente ataque de la rama se agrega al mismo hilo");
  assert.equal(finalChat.messages[3].kind, "attack");
  assert.equal(finalChat.messages[3].attack_subject, "Es urgente, necesito eso ya");

  // el ataque ya contestado no debe seguir ofreciendo los mismos botones
  // (evita responder el mismo ataque de chat más de una vez); el nuevo
  // ataque de la rama (t2) no tiene ramas propias definidas en este test.
  assert.equal(finalChat.messages[1].branches.length, 0, "el ataque ya respondido no repite sus botones");
  assert.equal(finalChat.messages[3].branches.length, 0);

  // acción inválida sobre el delivery
  const badAction = await hop(`/t/${p.token}/d/${deliveryId}/branch`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action_key: "no_existe" }),
  });
  assert.equal(badAction.status, 404);

  // el evento de 'respuesta_participante' quedó contra el delivery original, no genérico
  const branchEvent = await pool.query(
    `SELECT detail FROM events WHERE delivery_id = $1 AND event_type = 'respuesta_participante'`, [deliveryId]
  );
  assert.equal(branchEvent.rows[0].detail, "no_puedo_ahora");
});

test("árbol de respuestas sobre un ataque de correo (no-chat) crea un delivery nuevo en la bandeja, sin tocar el chat", async () => {
  const c = await api("POST", "/api/campaigns", { name: `Camp ${Date.now()}` });
  const campaignId = c.body.campaign.id;

  const t1 = await api("POST", "/api/templates", {
    name: `Auth ${Date.now()}`, vector: "escasez", is_attack: true, channel: "web",
    sender_label: "Recursos Humanos", subject_or_headline: "Actualiza tu formulario de nómina",
    message_body: "Debes completar el formulario antes del viernes.", cta_label: "Completar", landing_kind: "form",
  });
  const t2 = await api("POST", "/api/templates", {
    name: `Auth ${Date.now() + 1}`, vector: "urgencia", is_attack: true, channel: "web",
    sender_label: "Recursos Humanos", subject_or_headline: "Último recordatorio",
    message_body: "Este es el último aviso antes del cierre.", cta_label: "Completar ahora", landing_kind: "form",
  });
  await api("POST", `/api/templates/${t1.body.template.id}/branches`, {
    action_key: "necesito_mas_tiempo", action_label: "Necesito más tiempo", to_template_id: t2.body.template.id,
  });

  const camp = await api("POST", "/api/campaigns", { name: `Camp2 ${Date.now()}`, template_ids: [t1.body.template.id] });
  const campaignId2 = camp.body.campaign.id;
  const msg = await api("POST", `/api/campaigns/${campaignId2}/messages`, { template_id: t1.body.template.id, kind: "email" });
  const team = `T ${Date.now()}`;
  const p = await makeParticipant(campaignId2, team);
  await api("POST", `/api/messages/${msg.body.message.id}/send`, { team_labels: [team] });

  const inboxHtml = await (await hop(`/t/${p.token}/app`)).text();
  const deliveryId = inboxHtml.match(/\/t\/[^/]+\/d\/([0-9a-f-]{36})/)[1];

  const branchRes = await hop(`/t/${p.token}/d/${deliveryId}/branch`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action_key: "necesito_mas_tiempo" }),
  });
  assert.equal(branchRes.status, 201);
  const branchBody = await branchRes.json();
  assert.equal(branchBody.appended_to_chat, false, "un ataque de correo no se inyecta en el chat");

  // no se creó ningún hilo/mensaje de chat para este participante
  const chatCount = await pool.query(`SELECT COUNT(*)::int n FROM chat_threads WHERE participant_campaign_id = $1`, [p.pcId]);
  assert.equal(chatCount.rows[0].n, 0);

  // el nuevo mensaje aparece en la bandeja como delivery independiente
  const inboxJson = await (await hop(`/t/${p.token}/inbox.json`)).json();
  assert.equal(inboxJson.items.length, 2);
  assert.ok(inboxJson.items.some((i) => i.subject === "Último recordatorio"));

  // limpieza explícita de la rama: /branches/:id (no anidada bajo /templates/:id)
  const branches = await api("GET", `/api/templates/${t1.body.template.id}/branches`);
  assert.equal(branches.status, 200);
  assert.equal(branches.body.branches.length, 1);
  const del = await api("DELETE", `/api/branches/${branches.body.branches[0].id}`);
  assert.equal(del.status, 200);
});

test("credenciales de práctica: coincidencia se calcula en memoria y solo se guarda el booleano, nunca el texto crudo", async () => {
  const t = await api("POST", "/api/templates", {
    name: `Auth ${Date.now()}`, vector: "autoridad", is_attack: true, channel: "web",
    sender_label: "Soporte TI", subject_or_headline: "Verifica tu cuenta", message_body: "Ingresa tus credenciales.",
    cta_label: "Ingresar", landing_kind: "form",
  });
  const c = await api("POST", "/api/campaigns", { name: `Camp ${Date.now()}`, template_ids: [t.body.template.id] });
  const campaignId = c.body.campaign.id;
  const msg = await api("POST", `/api/campaigns/${campaignId}/messages`, { template_id: t.body.template.id });
  const team = `T ${Date.now()}`;
  const p = await makeParticipant(campaignId, team);
  await api("POST", `/api/messages/${msg.body.message.id}/send`, { team_labels: [team] });

  const assign = await api("POST", `/api/campaigns/${campaignId}/practice-credentials`, {
    assignments: [{ participant_campaign_id: p.pcId, username: "practica.usuario", password: "Practica#2026" }],
  });
  assert.equal(assign.status, 200);
  assert.equal(assign.body.updated, 1);

  const inboxHtml = await (await hop(`/t/${p.token}/app`)).text();
  const deliveryId = inboxHtml.match(/\/t\/[^/]+\/d\/([0-9a-f-]{36})/)[1];
  await hop(`/t/${p.token}/d/${deliveryId}/go`);

  // credenciales incorrectas
  await hop(`/t/${p.token}/d/${deliveryId}/submit`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ u: "otra_cosa", p: "otra_clave" }),
  });
  let d = await pool.query(`SELECT credential_match_result FROM deliveries WHERE id = $1`, [deliveryId]);
  assert.equal(d.rows[0].credential_match_result, false);

  // credenciales correctas (las de práctica asignadas)
  const submitOk = await hop(`/t/${p.token}/d/${deliveryId}/submit`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ u: "practica.usuario", p: "Practica#2026" }),
  });
  assert.equal(submitOk.status, 200);
  d = await pool.query(`SELECT credential_match_result FROM deliveries WHERE id = $1`, [deliveryId]);
  assert.equal(d.rows[0].credential_match_result, true);

  // propiedad de seguridad: el texto de la contraseña de práctica nunca queda
  // guardado en ninguna tabla que registre lo que escribió el participante.
  const events = await pool.query(`SELECT * FROM events WHERE participant_campaign_id = $1`, [p.pcId]);
  const chatMsgs = await pool.query(
    `SELECT cm.* FROM chat_messages cm JOIN chat_threads th ON th.id = cm.chat_thread_id WHERE th.participant_campaign_id = $1`,
    [p.pcId]
  );
  const haystack = JSON.stringify(events.rows) + JSON.stringify(chatMsgs.rows);
  assert.doesNotMatch(haystack, /Practica#2026/);
  assert.doesNotMatch(haystack, /otra_clave/);

  // participante sin credenciales asignadas: checkCredentialMatch no aplica (columna queda null)
  const p2 = await makeParticipant(campaignId, team);
  const msg2 = await api("POST", `/api/campaigns/${campaignId}/messages`, { template_id: t.body.template.id });
  await api("POST", `/api/messages/${msg2.body.message.id}/send`, { team_labels: [team] });
  const inboxHtml2 = await (await hop(`/t/${p2.token}/app`)).text();
  const deliveryId2 = inboxHtml2.match(/\/t\/[^/]+\/d\/([0-9a-f-]{36})/)[1];
  await hop(`/t/${p2.token}/d/${deliveryId2}/submit`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ u: "x", p: "y" }),
  });
  const d2 = await pool.query(`SELECT credential_match_result FROM deliveries WHERE id = $1`, [deliveryId2]);
  assert.equal(d2.rows[0].credential_match_result, null, "sin credenciales de práctica asignadas, no se calcula coincidencia");
});

test("plantillas 'chat directo': se pueden guardar con kind='chat' y el dashboard las cuenta por canal", async () => {
  // Admin: la biblioteca de plantillas ahora acepta un tercer "Formato"
  // además de correo/tarea -- una plantilla pensada solo para insertarse en
  // un guion de chat (ver admin.html tab 3 y templates.js KINDS).
  const tplChat = await api("POST", "/api/templates", {
    name: `Chat directo ${Date.now()}`, vector: "urgencia", is_attack: true, kind: "chat",
    sender_label: "Andrés Gómez", subject_or_headline: "¿Puedes confirmarme esto ya?",
    message_body: "Sistemas me está pidiendo que confirmes tus credenciales del portal ahora mismo.",
    cta_label: "Confirmar", landing_kind: "form",
  });
  assert.equal(tplChat.status, 201);
  assert.equal(tplChat.body.template.kind, "chat");

  const invalidKind = await api("POST", "/api/templates", {
    name: `Kind inválido ${Date.now()}`, vector: "urgencia", is_attack: true, kind: "sms",
    subject_or_headline: "x",
  });
  assert.equal(invalidKind.status, 400);

  const campaignId = (await api("POST", "/api/campaigns", { name: `Camp ${Date.now()}` })).body.campaign.id;
  const contact = await api("POST", `/api/campaigns/${campaignId}/contacts`, { display_name: "Andrés Gómez" });
  await api("POST", `/api/campaigns/${campaignId}/chat-scripts`, {
    name: "Guion con plantilla de chat directo",
    script: [{ type: "attack", template_id: tplChat.body.template.id, sender_contact_id: contact.body.contact.id }],
  });
  const p = await makeParticipant(campaignId, `T ${Date.now()}`);
  const chatJson = await (await hop(`/t/${p.token}/chat.json`)).json();
  assert.equal(chatJson.messages[0].kind, "attack");
  const deliveryId = chatJson.messages[0].delivery_id;

  // El ataque quedó registrado como un delivery normal con messages.kind =
  // 'chat' (chat.js lo fija así al instanciar, ver comentario más arriba) --
  // por eso el desglose por canal del dashboard debe reflejar este delivery
  // bajo la clave 'chat'.
  const kindRow = await pool.query(`SELECT kind FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE d.id = $1`, [deliveryId]);
  assert.equal(kindRow.rows[0].kind, "chat");

  const overview = await api("GET", "/api/dashboard/overview");
  assert.equal(overview.status, 200);
  assert.ok(Array.isArray(overview.body.por_canal), "el overview expone por_canal");
  const chatCanal = overview.body.por_canal.find((r) => r.clave === "chat");
  assert.ok(chatCanal, "hay una fila 'chat' en por_canal tras entregar un ataque por chat");
  assert.ok(chatCanal.expuestos >= 1);
});

test("semillas de un clic (paso 6): compañeros, plantillas de tablero y guiones de chat de ejemplo, idempotentes", async () => {
  // Pedido del usuario: poder "presionar" en vez de crear todo desde cero en
  // el módulo de interacción, igual que ya existía para la biblioteca de
  // mensajes (POST /api/templates/seed-defaults).
  const campaignId = (await api("POST", "/api/campaigns", { name: `Seed int ${Date.now()}` })).body.campaign.id;

  const seedContacts1 = await api("POST", `/api/campaigns/${campaignId}/contacts/seed-defaults`, {});
  assert.equal(seedContacts1.status, 201);
  assert.equal(seedContacts1.body.total, 5);
  assert.ok(seedContacts1.body.contacts.every((c) => !c.skipped), "la primera vez no debería saltarse ninguno");

  // segunda vez: idempotente, no duplica
  const seedContacts2 = await api("POST", `/api/campaigns/${campaignId}/contacts/seed-defaults`, {});
  assert.ok(seedContacts2.body.contacts.every((c) => c.skipped), "la segunda vez debería saltarse todos");
  const contactsList = await api("GET", `/api/campaigns/${campaignId}/contacts`);
  assert.equal(contactsList.body.contacts.length, 5, "no se duplican compañeros entre llamadas");

  // plantillas de tablero de ejemplo: no depende de haber corrido el seed de
  // compañeros antes -- debe crear los que hagan falta por su cuenta.
  const freshCampaignId = (await api("POST", "/api/campaigns", { name: `Seed board ${Date.now()}` })).body.campaign.id;
  const seedBoards = await api("POST", `/api/campaigns/${freshCampaignId}/board-templates/seed-defaults`, {});
  assert.equal(seedBoards.status, 201);
  assert.equal(seedBoards.body.total, 2);
  assert.ok(seedBoards.body.board_templates.every((t) => !t.skipped && !t.error));
  const boardsList = await api("GET", `/api/campaigns/${freshCampaignId}/board-templates`);
  const seedRows = boardsList.body.board_templates.find((t) => t.name === "Lanzamiento de producto Q4").seed;
  const firstTask = seedRows[0].tasks[0];
  assert.ok(firstTask.responsible_contact_id, "la tarea de ejemplo queda con un responsable real, no null");
  assert.equal(firstTask.priority, "alta");
  assert.ok(firstTask.checklist.length > 0);
  const contactsAfterBoards = await api("GET", `/api/campaigns/${freshCampaignId}/contacts`);
  assert.ok(contactsAfterBoards.body.contacts.some((c) => c.display_name === "Laura Méndez"),
    "sembrar plantillas de tablero crea los compañeros que necesita, sin depender de otro botón");

  // segunda vez: idempotente
  const seedBoards2 = await api("POST", `/api/campaigns/${freshCampaignId}/board-templates/seed-defaults`, {});
  assert.ok(seedBoards2.body.board_templates.every((t) => t.skipped));

  // guiones de chat de ejemplo: pedido del usuario, uno POR CADA CASO de
  // ataque "chat directo" que exista en la biblioteca (no una lista fija de
  // 2, ni uno por vector -- si dos plantillas comparten vector, cada una
  // saca su propio guion, nombrado según la plantilla exacta, para que
  // ninguna tape a la otra). Hoy la biblioteca estándar trae 5: Autoridad,
  // Urgencia, Escasez, Prueba social y Curiosidad (ver templates.js). Las
  // plantillas son globales (no por campaña), y otra prueba de este mismo
  // archivo ("plantillas 'chat directo'...") crea y ENTREGA de verdad una
  // plantilla de chat propia -- una vez entregada, no se puede borrar (con
  // razón: en un laboratorio real no se debe poder borrar una plantilla que
  // ya generó datos), así que esta prueba nunca asume que el catálogo
  // global de plantillas de chat pueda quedar en cero por su cuenta. En vez
  // de eso, borra lo que sí se pueda borrar y compara siempre contra lo que
  // realmente queda en cada momento (vía GET), para no depender del orden
  // de ejecución ni de qué haya quedado pegado de otra prueba.
  const freshCampaignId2 = (await api("POST", "/api/campaigns", { name: `Seed chat ${Date.now()}` })).body.campaign.id;
  const isChatAttack = (t) => t.kind === "chat" && t.is_attack;
  const before = await api("GET", "/api/templates");
  for (const tpl of before.body.templates.filter(isChatAttack)) {
    await api("DELETE", `/api/templates/${tpl.id}`);
  }
  const stillThere = (await api("GET", "/api/templates")).body.templates.filter(isChatAttack);

  const seedChatsMissing = await api("POST", `/api/campaigns/${freshCampaignId2}/chat-scripts/seed-defaults`, {});
  assert.equal(seedChatsMissing.status, 201);
  assert.equal(seedChatsMissing.body.total, stillThere.length,
    "el total siempre refleja cuántas plantillas de ataque de chat existen de verdad en ese momento");
  if (stillThere.length === 0) {
    assert.ok(seedChatsMissing.body.error, "sin ninguna plantilla de chat, avisa en vez de fallar en silencio o no hacer nada sin explicar por qué");
  } else {
    assert.ok(!seedChatsMissing.body.error);
  }

  // restaura las plantillas estándar que se hayan podido borrar arriba
  // (idempotente por nombre: si alguna ya sigue existiendo -- como la que
  // quedó pegada de la otra prueba -- no la toca; si falta, la recrea).
  await api("POST", "/api/templates/seed-defaults", {});
  const finalTpls = (await api("GET", "/api/templates")).body.templates.filter(isChatAttack);
  assert.ok(finalTpls.length >= 5, "la biblioteca estándar aporta al menos las 5 plantillas de chat, una por vector");

  const seedChats = await api("POST", `/api/campaigns/${freshCampaignId2}/chat-scripts/seed-defaults`, {});
  assert.equal(seedChats.status, 201);
  assert.equal(seedChats.body.total, finalTpls.length,
    "un guion (o intento) por cada plantilla de ataque de chat que exista, sin importar cuántas sean");
  assert.ok(!seedChats.body.error);

  // cada plantilla de ataque de chat -- estándar o no -- debe tener su
  // PROPIO guion, nombrado según ESA plantilla exacta, con el template_id
  // correcto (nunca el de otra plantilla del mismo vector).
  for (const tpl of finalTpls) {
    const name = `Guion — ${tpl.name}`;
    const s = seedChats.body.chat_scripts.find((x) => x.name === name);
    assert.ok(s, `debería existir un guion para la plantilla "${tpl.name}": ${name}`);
    assert.ok(!s.error, `"${name}" no debería fallar teniendo su plantilla disponible`);
  }
  const standardVectors = ["autoridad", "urgencia", "escasez", "prueba_social", "curiosidad"];
  for (const vector of standardVectors) {
    assert.ok(finalTpls.some((t) => t.vector === vector),
      `la biblioteca estándar debería aportar al menos una plantilla de chat para "${vector}"`);
  }

  // segunda vez: idempotente, no duplica
  const seedChats2 = await api("POST", `/api/campaigns/${freshCampaignId2}/chat-scripts/seed-defaults`, {});
  assert.equal(seedChats2.body.total, finalTpls.length);
  assert.ok(seedChats2.body.chat_scripts.every((s) => s.skipped));

  // caso concreto: la plantilla estándar de Urgencia queda con SU PROPIO
  // guion y SU PROPIO template_id, sin importar si algún otro caso comparte
  // su mismo vector.
  const urgenciaTpl = finalTpls.find((t) => t.vector === "urgencia" && t.name === "Urgencia — Chat: se cae la demo si no confirmas ya");
  assert.ok(urgenciaTpl, "la plantilla estándar de Urgencia debería seguir en el catálogo");
  const chatScriptsList = await api("GET", `/api/campaigns/${freshCampaignId2}/chat-scripts`);
  const urgenciaScript = chatScriptsList.body.chat_scripts.find((s) => s.name === `Guion — ${urgenciaTpl.name}`);
  assert.ok(urgenciaScript, "el guion de la plantilla estándar de Urgencia debería existir con su propio nombre");
  assert.equal(urgenciaScript.script.length, 2);
  assert.equal(urgenciaScript.script[0].type, "scripted");
  assert.ok(urgenciaScript.script[0].sender_contact_id, "el mensaje ambiente queda con un remitente real, no null");
  assert.equal(urgenciaScript.script[1].type, "attack");
  assert.equal(urgenciaScript.script[1].template_id, urgenciaTpl.id,
    "el paso de ataque apunta exactamente a la plantilla de Urgencia, no a otra del mismo vector");
});
