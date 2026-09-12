const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const statusEl = $("#status");
let KEY = sessionStorage.getItem("paws_admin_key") || "";
if (KEY) $("#apiKey").value = KEY;

const VEC_LABEL = { autoridad: "autoridad", urgencia: "urgencia", escasez: "escasez", prueba_social: "prueba social", curiosidad: "curiosidad" };
const KIND_LABEL = { email: "correo", task: "tarea", chat: "chat directo" };
const badge = (v, atk) => atk === false
  ? `<span class="badge benigno">relleno</span>`
  : `<span class="badge ${v}">${VEC_LABEL[v] || v}</span>`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(method, path, body, isText) {
  const headers = { "x-api-key": KEY };
  let payload;
  if (body !== undefined) {
    if (isText) { headers["Content-Type"] = "text/csv"; payload = body; }
    else { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  }
  const res = await fetch(path, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

$("#connectBtn").addEventListener("click", async () => {
  KEY = $("#apiKey").value.trim();
  sessionStorage.setItem("paws_admin_key", KEY);
  try { await api("GET", "/api/templates"); statusEl.textContent = "Conectado ✓"; refreshAll(); }
  catch (e) { statusEl.textContent = "Error: " + e.message; }
});

$$(".steps button").forEach((b) => b.addEventListener("click", () => {
  $$(".steps button").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  $$(".tabpane").forEach((p) => (p.hidden = true));
  $("#tab-" + b.dataset.tab).hidden = false;
  if (b.dataset.tab === "res") loadResults();
  if (b.dataset.tab === "int") loadInteraction();
}));
function markDone(tab, done) {
  const b = $(`.steps button[data-tab="${tab}"]`);
  if (b) b.classList.toggle("done", !!done);
}

function refreshAll() {
  loadParticipants();
  loadTemplates();
  loadCampaigns();
}

/* ================= CAMPAÑA ACTIVA (selector global) ================= */
let CAMPAIGNS = [], CURRENT_CAMP = null, LINKS = [];

$("#campSel").addEventListener("change", () => {
  CURRENT_CAMP = $("#campSel").value || null;
  sessionStorage.setItem("paws_camp", CURRENT_CAMP || "");
  onCampaignChange();
});

async function loadCampaigns() {
  const { campaigns } = await api("GET", "/api/campaigns");
  CAMPAIGNS = campaigns;
  const saved = CURRENT_CAMP || sessionStorage.getItem("paws_camp") || "";
  $("#campSel").innerHTML = '<option value="">—</option>' +
    campaigns.map((c) => `<option value="${c.id}">${esc(c.name)} · ${esc(c.status)}</option>`).join("");
  CURRENT_CAMP = campaigns.find((c) => c.id === saved) ? saved : (campaigns[0]?.id || null);
  $("#campSel").value = CURRENT_CAMP || "";
  onCampaignChange();
}

function currentCampaign() { return CAMPAIGNS.find((c) => c.id === CURRENT_CAMP) || null; }

function onCampaignChange() {
  const c = currentCampaign();
  $("#msgNoCamp").hidden = !!c;
  markDone("part", true); // si conectó, asumimos que ya importó o lo hará
  if (!c) {
    $("#campDetailPanel").hidden = true;
    $("#msgTable tbody").innerHTML = "";
    return;
  }
  $("#campDetailPanel").hidden = false;
  $("#campDetailName").textContent = c.name;
  $("#campStatusBadge").textContent = c.status;
  $("#joltingProb").value = c.jolting_probability ?? 1;
  $("#riskThreshold").value = c.risk_threshold ?? 0.5;
  loadLinks();
  loadPreflight();
  loadMessages();
  markDone("camp", Number(c.links) > 0);
  // El módulo de interacción (paso 6) es por campaña: al cambiar de campaña,
  // los constructores en curso (tablero/guion sin guardar) ya no aplican.
  boardTplColumns = []; renderBoardTplCols();
  chatScriptSteps = []; renderChatScriptSteps();
  if (!$("#tab-int").hidden) loadInteraction();
}

/* ================= 1 · PARTICIPANTES ================= */
async function loadParticipants() {
  const { participants } = await api("GET", "/api/participants");
  $("#partCount").textContent = participants.length;
  $("#partTable tbody").innerHTML = participants.map((p) => `<tr>
    <td><code>${esc(p.external_hash)}</code></td><td>${esc(p.role)}</td>
    <td>${esc(p.team_label || "—")}</td><td>${p.consent_given ? "sí" : "no"}</td></tr>`).join("");
  markDone("part", participants.length > 0);
}
$("#importCsvBtn").addEventListener("click", async () => {
  try { const r = await api("POST", "/api/participants/import-csv", $("#csvBox").value, true);
    $("#importMsg").textContent = `Importados ${r.imported}${r.failed ? `, ${r.failed} con error` : ""}.`;
    loadParticipants(); }
  catch (e) { $("#importMsg").textContent = "Error: " + e.message; }
});
$("#importJsonBtn").addEventListener("click", async () => {
  try { const r = await api("POST", "/api/participants/import", JSON.parse($("#jsonBox").value));
    $("#importMsg").textContent = `Importados ${r.imported}, con error ${r.failed}.`; loadParticipants(); }
  catch (e) { $("#importMsg").textContent = "Error: " + e.message; }
});

/* ================= 2 · CAMPAÑA Y ENLACES ================= */
$("#campForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("POST", "/api/campaigns", { name: e.target.name.value });
    e.target.reset();
    CURRENT_CAMP = r.campaign.id;
    sessionStorage.setItem("paws_camp", CURRENT_CAMP);
    await loadCampaigns();
    statusEl.textContent = "Campaña creada ✓";
  } catch (err) { alert(err.message); }
});

function linkBase() {
  const v = ($("#linkBase").value || "").trim().replace(/\/+$/, "");
  return v || location.origin;
}
if ($("#linkBase") && !$("#linkBase").value) $("#linkBase").value = location.origin;
$("#linkBase") && $("#linkBase").addEventListener("change", () => { if (CURRENT_CAMP) loadLinks(); });

async function loadLinks() {
  const { links } = await api("GET", `/api/campaigns/${CURRENT_CAMP}/links`);
  LINKS = links;
  $("#linksTable tbody").innerHTML = links.map((l) => `<tr>
    <td><code>${esc(l.external_hash)}</code></td><td>${esc(l.role)}</td><td>${esc(l.team_label || "—")}</td>
    <td>${esc(l.group_assignment || "—")}</td>
    <td>${l.mensajes}</td><td>${l.encuesta ? "sí" : "no"}</td>
    <td><a href="${l.url}" target="_blank">${esc(linkBase())}${l.url}</a></td>
    <td><button class="btn-xs ghost" data-reset="${l.id}">reiniciar</button></td>
  </tr>`).join("") || `<tr><td colspan="8" class="hint">Aún no hay enlaces. Pulsa "Generar enlaces para todos".</td></tr>`;
  $$("#linksTable [data-reset]").forEach((b) => b.onclick = async () => {
    if (confirm("¿Reiniciar este participante? Borra sus eventos y su encuesta.")) {
      try { await api("POST", `/api/campaigns/${CURRENT_CAMP}/participants/${b.dataset.reset}/reset`); loadLinks(); loadPreflight(); }
      catch (e) { alert(e.message); }
    }
  });
}

async function loadPreflight() {
  const el = $("#preflight");
  const verdictEl = $("#preflightVerdict");
  const c = currentCampaign();
  if (!c) { el.innerHTML = '<li><span class="mark">·</span> Elige una campaña.</li>'; verdictEl.innerHTML = ""; return; }

  const [{ participants }, { links }, { teams }] = await Promise.all([
    api("GET", "/api/participants"),
    api("GET", `/api/campaigns/${c.id}/links`),
    api("GET", `/api/campaigns/${c.id}/coverage`),
  ]);

  const items = [];
  // 1) participantes importados
  items.push(participants.length > 0
    ? { s: "ok", t: `Hay ${participants.length} participantes cargados.` }
    : { s: "no", t: "No hay participantes. Ve al paso 1." });
  // 2) enlaces para todos
  if (links.length === 0) items.push({ s: "no", t: "Nadie tiene enlace todavía. Pulsa \"Generar enlaces para todos\"." });
  else if (links.length < participants.length) items.push({ s: "warn", t: `${links.length} de ${participants.length} participantes tienen enlace. Genera los que faltan.` });
  else items.push({ s: "ok", t: `Los ${links.length} participantes tienen enlace.` });
  // 3) una técnica de ataque por equipo
  const attackTeams = teams.filter((tm) => tm.participantes > 0 || tm.ataques.length);
  if (attackTeams.length === 0) {
    items.push({ s: "no", t: "Ningún equipo tiene enlaces. Genera los enlaces primero." });
  } else {
    const sinAtaque = attackTeams.filter((tm) => tm.ataques.length === 0).map((tm) => tm.team_label);
    const conVarias = attackTeams.filter((tm) => new Set(tm.ataques.map((a) => a.vector)).size > 1).map((tm) => tm.team_label);
    if (sinAtaque.length) items.push({ s: "no", t: `Falta enviar el ataque a: ${sinAtaque.join(", ")} (paso 4).` });
    if (conVarias.length) items.push({ s: "warn", t: `Estos equipos recibieron más de una técnica y mezclan datos: ${conVarias.join(", ")}.` });
    if (!sinAtaque.length && !conVarias.length) {
      const resumen = attackTeams.map((tm) => `${tm.team_label} → ${VEC_LABEL[tm.ataques[0].vector] || tm.ataques[0].vector}`).join(" · ");
      items.push({ s: "ok", t: `Cada equipo tiene una técnica: ${resumen}.` });
    }
  }
  // 4) campaña en curso
  items.push(c.status === "en_curso"
    ? { s: "ok", t: "La campaña está \"en curso\"." }
    : { s: "warn", t: `La campaña está en "${c.status}". Márcala "en curso" al empezar la sesión.` });

  el.innerHTML = items.map((i) => `<li class="${i.s}"><span class="mark">${i.s === "ok" ? "✓" : i.s === "warn" ? "!" : "✕"}</span><span>${esc(i.t)}</span></li>`).join("");
  const bad = items.some((i) => i.s === "no");
  const warn = items.some((i) => i.s === "warn");
  verdictEl.innerHTML = bad
    ? `<div class="readout warn">Todavía faltan pasos antes de la sesión (mira las ✕ de arriba).</div>`
    : warn
    ? `<div class="readout warn">Casi listo. Revisa los avisos (!) — puedes continuar si son intencionados.</div>`
    : `<div class="readout ok">✓ Listo para la sesión. Reparte los enlaces y, cuando empiecen, envía cada ataque.</div>`;
}

$("#genTokensBtn").addEventListener("click", async () => {
  try { const r = await api("POST", `/api/campaigns/${CURRENT_CAMP}/generate-tokens`, {});
    statusEl.textContent = `${r.generated} enlaces nuevos ✓`; await loadCampaigns(); }
  catch (e) { alert(e.message); }
});
// Resumen legible de la respuesta de /assign-groups, reutilizado por los dos
// botones (con y sin force) — ver POST /api/campaigns/:id/assign-groups.
function renderGroupsResult(r) {
  const partes = [`Asignados: ${r.asignados} (control ${r.resumen.control} / experimental ${r.resumen.experimental})`];
  if (r.omitidos_ya_asignados) partes.push(`ya tenían grupo: ${r.omitidos_ya_asignados}`);
  if (r.omitidos_por_sesion_iniciada) partes.push(`sesión ya iniciada, no tocados: ${r.omitidos_por_sesion_iniciada}`);
  $("#groupsMsg").textContent = partes.join(" · ") + " ✓";
}
$("#assignGroupsBtn").addEventListener("click", async () => {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  $("#groupsMsg").textContent = "Asignando…";
  try { const r = await api("POST", `/api/campaigns/${CURRENT_CAMP}/assign-groups`, {}); renderGroupsResult(r); await loadLinks(); }
  catch (e) { $("#groupsMsg").textContent = "Error: " + e.message; }
});
$("#assignGroupsForceBtn").addEventListener("click", async () => {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  if (!confirm("¿Reasignar el grupo de TODOS los participantes de esta campaña, incluso los que ya tenían uno puesto a mano? (Nunca toca a quien ya empezó su sesión).")) return;
  $("#groupsMsg").textContent = "Reasignando…";
  try { const r = await api("POST", `/api/campaigns/${CURRENT_CAMP}/assign-groups`, { force: true }); renderGroupsResult(r); await loadLinks(); }
  catch (e) { $("#groupsMsg").textContent = "Error: " + e.message; }
});
$("#saveJoltingBtn").addEventListener("click", async () => {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  const probability = Number($("#joltingProb").value);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    $("#joltingMsg").textContent = "Escribe un número entre 0 y 1.";
    return;
  }
  $("#joltingMsg").textContent = "Guardando…";
  try { await api("PATCH", `/api/campaigns/${CURRENT_CAMP}/jolting`, { probability }); await loadCampaigns();
    $("#joltingMsg").textContent = `Probabilidad guardada: ${probability} ✓ (afecta a los mensajes que envíes desde ahora)`; }
  catch (e) { $("#joltingMsg").textContent = "Error: " + e.message; }
});
$("#saveRiskThresholdBtn").addEventListener("click", async () => {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  const threshold = Number($("#riskThreshold").value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    $("#riskThresholdMsg").textContent = "Escribe un número entre 0 y 1.";
    return;
  }
  $("#riskThresholdMsg").textContent = "Guardando…";
  try { await api("PATCH", `/api/campaigns/${CURRENT_CAMP}/risk-threshold`, { threshold }); await loadCampaigns();
    $("#riskThresholdMsg").textContent = `Umbral guardado: ${threshold} ✓ (modo sombra — no afecta a lo que ve el participante)`; }
  catch (e) { $("#riskThresholdMsg").textContent = "Error: " + e.message; }
});
async function setStatus(status) {
  try { await api("PATCH", `/api/campaigns/${CURRENT_CAMP}/status`, { status }); await loadCampaigns(); statusEl.textContent = `Campaña: ${status} ✓`; }
  catch (e) { alert(e.message); }
}
$("#startCampBtn").addEventListener("click", () => setStatus("en_curso"));
$("#finishCampBtn").addEventListener("click", () => { if (confirm("¿Marcar la campaña como finalizada? Habilita la encuesta para quien no pulsó \"Finalizar\".")) setStatus("finalizada"); });
$("#resetCampBtn").addEventListener("click", async () => {
  if (!confirm("¿Reiniciar TODA la campaña? Borra eventos, envíos y encuestas de todos. Conserva participantes y mensajes.")) return;
  try { const r = await api("POST", `/api/campaigns/${CURRENT_CAMP}/reset`); statusEl.textContent = `Reiniciados ${r.reset} ✓`; onCampaignChange(); }
  catch (e) { alert(e.message); }
});
$("#copyLinksBtn").addEventListener("click", () => {
  navigator.clipboard.writeText(LINKS.map((l) => `${l.external_hash}\t${linkBase()}${l.url}`).join("\n"))
    .then(() => statusEl.textContent = "Enlaces copiados ✓");
});
$("#downloadLinksBtn").addEventListener("click", () => {
  const rows = [["external_hash", "role", "team_label", "url"]].concat(LINKS.map((l) => [l.external_hash, l.role, l.team_label || "", linkBase() + l.url]));
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "enlaces.csv"; a.click();
});

/* ================= 3 · PLANTILLAS ================= */
let TEMPLATES = [];
function toggleAttackFields() {
  const atk = $("#isAttack").value === "true";
  $$("#tplForm .attack-only").forEach((e) => (e.style.display = atk ? "" : "none"));
  $("#vectorRow").style.display = atk ? "" : "none";
  $("#scopeRow").style.display = atk && $("#landingKind").value === "permiso" ? "" : "none";
}
$("#isAttack").addEventListener("change", toggleAttackFields);
$("#landingKind").addEventListener("change", toggleAttackFields);

async function loadTemplates() {
  const { templates } = await api("GET", "/api/templates");
  TEMPLATES = templates;
  const atk = templates.filter((t) => t.is_attack);
  const ben = templates.filter((t) => !t.is_attack);
  $("#tplAtkTable tbody").innerHTML = atk.map((t) => `<tr>
    <td>${esc(t.name)}</td><td>${badge(t.vector, true)}</td>
    <td>${esc(KIND_LABEL[t.kind] || t.kind)}</td><td>${esc(t.landing_kind)}</td>
    <td><button class="btn-xs" data-edit="${t.id}">editar</button> <button class="btn-xs ghost" data-del="${t.id}">borrar</button></td>
  </tr>`).join("") || `<tr><td colspan="5" class="hint">Sin plantillas de ataque. Pulsa "Crear biblioteca estándar".</td></tr>`;
  $("#tplBenTable tbody").innerHTML = ben.map((t) => `<tr>
    <td>${esc(t.name)}</td><td>${esc(KIND_LABEL[t.kind] || t.kind)}</td><td>${esc(t.sender_label || "—")}</td>
    <td><button class="btn-xs" data-edit="${t.id}">editar</button> <button class="btn-xs ghost" data-del="${t.id}">borrar</button></td>
  </tr>`).join("") || `<tr><td colspan="4" class="hint">Sin plantillas de relleno.</td></tr>`;
  $$("#tab-tpl [data-edit]").forEach((b) => b.onclick = () => editTemplate(b.dataset.edit));
  $$("#tab-tpl [data-del]").forEach((b) => b.onclick = async () => {
    if (confirm("¿Borrar plantilla?")) { try { await api("DELETE", "/api/templates/" + b.dataset.del); loadTemplates(); } catch (e) { alert(e.message); } }
  });
  markDone("tpl", atk.length > 0);
  fillMsgTemplateSelect();
}

$("#seedDefaultsBtn").addEventListener("click", async () => {
  try { const r = await api("POST", "/api/templates/seed-defaults", {}); loadTemplates(); statusEl.textContent = `Biblioteca lista (${r.total}) ✓`; }
  catch (e) { alert(e.message); }
});
$("#seedReplaceBtn").addEventListener("click", async () => {
  if (!confirm("¿Restaurar los textos estándar? Sobrescribe las plantillas con el mismo nombre; no toca las tuyas.")) return;
  try { const r = await api("POST", "/api/templates/seed-defaults", { replace: true }); loadTemplates(); statusEl.textContent = `Textos restaurados (${r.total}) ✓`; }
  catch (e) { alert(e.message); }
});

function editTemplate(id) {
  const t = TEMPLATES.find((x) => x.id === id); if (!t) return;
  const f = $("#tplForm");
  f.id.value = t.id; f.name.value = t.name; f.kind.value = t.kind;
  f.is_attack.value = String(t.is_attack); f.vector.value = t.vector;
  f.sender_label.value = t.sender_label || ""; f.subject_or_headline.value = t.subject_or_headline;
  f.message_body.value = t.message_body || ""; f.cta_label.value = t.cta_label || "";
  f.landing_kind.value = t.landing_kind || "form"; f.scope.value = t.landing_config?.scope || "perfil";
  f.landing_titulo.value = t.landing_config?.titulo || ""; f.landing_detalle.value = t.landing_config?.detalle || "";
  toggleAttackFields();
  $("#tplFormTitle").textContent = "Editar plantilla"; $("#tplCancel").style.display = "";
  $("#tplForm").scrollIntoView({ behavior: "smooth" });
}
$("#tplCancel").addEventListener("click", resetTplForm);
function resetTplForm() {
  $("#tplForm").reset(); $("#tplForm").id.value = "";
  $("#tplFormTitle").textContent = "Nueva plantilla"; $("#tplCancel").style.display = "none";
  toggleAttackFields();
}
$("#tplForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const isAttack = f.is_attack.value === "true";
  const landing_config = {};
  if (isAttack) {
    if (f.landing_kind.value === "permiso") landing_config.scope = f.scope.value;
    if (f.landing_titulo.value) landing_config.titulo = f.landing_titulo.value;
    if (f.landing_detalle.value) landing_config.detalle = f.landing_detalle.value;
  }
  const payload = {
    name: f.name.value, kind: f.kind.value, is_attack: isAttack, vector: f.vector.value,
    sender_label: f.sender_label.value || null, subject_or_headline: f.subject_or_headline.value,
    message_body: f.message_body.value || null, cta_label: f.cta_label.value || "Abrir",
    landing_kind: f.landing_kind.value, landing_config,
  };
  try {
    if (f.id.value) await api("PUT", "/api/templates/" + f.id.value, payload);
    else await api("POST", "/api/templates", payload);
    resetTplForm(); loadTemplates(); statusEl.textContent = "Plantilla guardada ✓";
  } catch (err) { alert(err.message); }
});

/* ================= 4 · MENSAJES ================= */
let CURRENT_MSG = null;
function fillMsgTemplateSelect() {
  // Las plantillas "chat directo" (kind === "chat") no se ofrecen acá: este
  // formulario envía a la BANDEJA/tareas del participante, no al chat -- una
  // plantilla de chat solo se inserta como ataque dentro de un guion de chat
  // (paso 6, "Guiones de chat"). Mostrarla aquí llevaría a un mensaje con un
  // "Formato" que este <select> ni siquiera ofrece (ver admin.html).
  $("#msgTpl").innerHTML = '<option value="">— redactar desde cero —</option>' +
    TEMPLATES.filter((t) => t.kind !== "chat")
      .map((t) => `<option value="${t.id}">${t.is_attack ? "[ataque " + (VEC_LABEL[t.vector] || t.vector) + "] " : "[relleno] "}${esc(t.name)}</option>`).join("");
}
function toggleMsgAttack() { $$("#msgForm .msgatk").forEach((e) => (e.style.display = $("#msgIsAttack").value === "true" ? "" : "none")); }
$("#msgIsAttack").addEventListener("change", toggleMsgAttack);
$("#msgTpl").addEventListener("change", (e) => {
  const t = TEMPLATES.find((x) => x.id === e.target.value);
  const f = $("#msgForm");
  if (t) {
    f.kind.value = t.kind; f.is_attack.value = String(t.is_attack); f.vector.value = t.vector;
    f.sender_label.value = t.sender_label || ""; f.subject.value = t.subject_or_headline;
    f.body.value = t.message_body || ""; f.cta_label.value = t.cta_label || "";
    f.landing_kind.value = t.landing_kind || "form";
  }
  toggleMsgAttack();
});

async function loadMessages() {
  if (!CURRENT_CAMP) { $("#msgTable tbody").innerHTML = ""; return; }
  const { messages } = await api("GET", `/api/campaigns/${CURRENT_CAMP}/messages`);
  $("#msgTable tbody").innerHTML = messages.map((m) => `<tr>
    <td>${esc(m.subject)}</td><td>${badge(m.vector, m.is_attack)}</td><td>${m.is_attack ? (VEC_LABEL[m.vector] || m.vector) : "—"}</td>
    <td>${m.is_attack ? (m.jolting_enabled ? "puede salir" : "nunca") : "—"}</td>
    <td>${m.enviados}</td><td>${m.abiertos}</td><td>${m.clics}</td><td>${m.conversiones}</td><td>${m.reportes}</td>
    <td>
      <button class="btn-xs" data-send="${m.id}" data-subj="${esc(m.subject)}" data-atk="${m.is_attack}" data-vec="${esc(m.vector || "")}">enviar</button>
      <button class="btn-xs ghost" data-clone="${m.id}">clonar</button>
      <button class="btn-xs ghost" data-delmsg="${m.id}">borrar</button>
    </td></tr>`).join("") || `<tr><td colspan="10" class="hint">Sin mensajes. Redacta uno arriba.</td></tr>`;
  $$("#msgTable [data-send]").forEach((b) => b.onclick = () => openSend(b.dataset));
  $$("#msgTable [data-clone]").forEach((b) => b.onclick = async () => { try { await api("POST", `/api/messages/${b.dataset.clone}/clone`); loadMessages(); } catch (e) { alert(e.message); } });
  $$("#msgTable [data-delmsg]").forEach((b) => b.onclick = async () => { if (confirm("¿Borrar mensaje y sus envíos?")) { try { await api("DELETE", `/api/messages/${b.dataset.delmsg}`); loadMessages(); loadPreflight(); } catch (e) { alert(e.message); } } });
  markDone("msg", messages.some((m) => m.is_attack && Number(m.enviados) > 0));
}
$("#msgForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  const f = e.target;
  const isAttack = f.is_attack.value === "true";
  // jolting_enabled solo tiene sentido para un mensaje de ataque, pero se
  // manda igual en ambos casos: el backend lo ignora para relleno.
  const joltingEnabled = f.jolting_enabled.checked;
  const payload = f.template_id.value
    ? { template_id: f.template_id.value, kind: f.kind.value, subject: f.subject.value || undefined, sender_label: f.sender_label.value || undefined, body: f.body.value || undefined, jolting_enabled: joltingEnabled }
    : { kind: f.kind.value, is_attack: isAttack, vector: isAttack ? f.vector.value : undefined, sender_label: f.sender_label.value || null,
        subject: f.subject.value, body: f.body.value || null, cta_label: isAttack ? (f.cta_label.value || "Abrir") : undefined,
        landing_kind: isAttack ? f.landing_kind.value : undefined, jolting_enabled: joltingEnabled };
  try { await api("POST", `/api/campaigns/${CURRENT_CAMP}/messages`, payload); f.reset(); toggleMsgAttack(); loadMessages(); statusEl.textContent = "Mensaje guardado ✓"; }
  catch (err) { alert(err.message); }
});

let COVERAGE = { teams: [] };
async function openSend(d) {
  CURRENT_MSG = { id: d.send, subject: d.subj, isAttack: d.atk === "true", vector: d.vec };
  $("#sendPanel").hidden = false;
  $("#sendMsgSubject").textContent = d.subj;
  $("#sendMsg").textContent = "";
  const [{ teams: tms }, cov] = await Promise.all([
    api("GET", `/api/campaigns/${CURRENT_CAMP}/teams`),
    api("GET", `/api/campaigns/${CURRENT_CAMP}/coverage`),
  ]);
  COVERAGE = cov;
  $("#sendTeams").innerHTML = tms.map((t) => {
    const c = cov.teams.find((x) => x.team_label === t.team_label);
    const otras = c ? [...new Set(c.ataques.map((a) => a.vector))].filter((v) => v !== CURRENT_MSG.vector) : [];
    const note = CURRENT_MSG.isAttack && otras.length ? ` — ⚠ ya recibió: ${otras.map((v) => VEC_LABEL[v] || v).join(", ")}` : "";
    return `<label class="chk"><input type="checkbox" value="${esc(t.team_label)}"> ${esc(t.team_label)} (${t.participantes})<span style="color:#b45309">${note}</span></label>`;
  }).join("") || '<span class="hint">No hay participantes con enlace. Genera los enlaces en el paso 2.</span>';
  $("#sendCoverage").innerHTML = CURRENT_MSG.isAttack
    ? "Recuerda: <strong>una técnica por equipo</strong>. Los equipos con ⚠ ya tienen otra técnica."
    : "Mensaje de relleno: puedes enviarlo a todos sin problema.";
  $("#sendPanel").scrollIntoView({ behavior: "smooth" });
}
async function doSend(body) {
  try {
    const r = await api("POST", `/api/messages/${CURRENT_MSG.id}/send`, body);
    $("#sendMsg").textContent = `Enviado a ${r.delivered} (${r.skipped} ya lo tenían).`;
    loadMessages(); loadPreflight(); loadCampaigns();
  } catch (e) { alert(e.message); }
}
$("#sendGoBtn").addEventListener("click", () => {
  const team_labels = $$("#sendTeams input:checked").map((i) => i.value);
  if (!team_labels.length) return alert("Marca al menos un equipo.");
  if (CURRENT_MSG.isAttack) {
    const conflict = team_labels.filter((tl) => {
      const c = COVERAGE.teams.find((x) => x.team_label === tl);
      return c && c.ataques.some((a) => a.vector !== CURRENT_MSG.vector);
    });
    if (conflict.length && !confirm(`${conflict.join(", ")} ya recibieron otra técnica. Enviar otra MEZCLA los datos de ese equipo y complica el análisis.\n\n¿Enviar de todas formas?`)) return;
  }
  doSend({ team_labels });
});
$("#sendAllBtn").addEventListener("click", () => {
  const msg = CURRENT_MSG.isAttack
    ? "Vas a enviar un ATAQUE a TODA la campaña. En esta prueba se recomienda una técnica por equipo, no la misma a todos. ¿Continuar?"
    : "¿Enviar este mensaje de relleno a toda la campaña?";
  if (confirm(msg)) doSend({ all: true });
});

/* ================= 5 · RESULTADOS ================= */
const ROLE_LABEL = { estudiante: "estudiante", profesor: "profesor", directivo: "directivo" };
function renderAttackBreakdown(tableId, rows, labelMap) {
  const tbody = $(`#${tableId} tbody`);
  tbody.innerHTML = (rows || []).length
    ? rows.map((r) => `<tr>
        <td>${esc((labelMap && labelMap[r.clave]) || r.clave)}</td>
        <td>${r.expuestos}</td><td>${r.abrieron}</td><td>${r.hicieron_clic}</td>
        <td>${r.cayeron}</td><td>${r.reportaron}</td>
        <td>${r.conversion_pct != null ? r.conversion_pct + "%" : "—"}</td>
        <td>${r.tiempo_reaccion_ms != null ? Math.round(r.tiempo_reaccion_ms) + "ms" : "—"}</td>
      </tr>`).join("")
    : `<tr><td colspan="8" class="hint">Todavía no hay ataques enviados.</td></tr>`;
}
async function loadResults() {
  try {
    const d = await api("GET", "/api/dashboard/overview");
    const t = d.totales || {}, f = d.embudo || {};
    const cards = [
      { v: f.recibieron ?? 0, l: "Recibieron el ataque" },
      { v: (f.cayeron ?? 0) + (f.recibieron ? ` (${Math.round((f.cayeron / f.recibieron) * 100)}%)` : ""), l: "Cayeron" },
      { v: f.reportaron ?? 0, l: "Lo reportaron" },
      { v: (d.percepcion?.reconocieron_pct ?? 0) + "%", l: "Reconocieron la simulación" },
    ];
    $("#resCards").innerHTML = cards.map((c) => `<div class="card"><div class="value">${c.v}</div><div class="label">${c.l}</div></div>`).join("");
    // por_tecnica/por_rol ya los calculaba este mismo endpoint desde hace
    // tiempo, pero nunca se pintaban en ningún lado del panel admin -- se
    // quedaban en la respuesta JSON sin que el admin pudiera verlos. Es la
    // única forma hoy de ver "qué técnica engancha más" sin abrir la base a
    // mano.
    renderAttackBreakdown("tecnicaTable", d.por_tecnica, VEC_LABEL);
    renderAttackBreakdown("rolTable", d.por_rol, ROLE_LABEL);
  } catch (e) {
    $("#resCards").innerHTML = `<p class="hint">Error: ${esc(e.message)}</p>`;
    $("#tecnicaTable tbody").innerHTML = $("#rolTable tbody").innerHTML = `<tr><td colspan="8" class="hint">Error al cargar.</td></tr>`;
  }
  loadBehaviorSummary();
  loadFeaturesSummary();
  loadFacialFeaturesSummary();
  loadRiskSummary();
}

/* -------- Features por sesión (etiquetado fino) -------- */
async function loadFeaturesSummary() {
  const tbody = $("#featuresTable tbody");
  if (!CURRENT_CAMP) { tbody.innerHTML = `<tr><td colspan="8" class="hint">Elige una campaña en el paso 2.</td></tr>`; return; }
  try {
    const { por_fase } = await api("GET", `/api/dashboard/features-summary?campaign_id=${CURRENT_CAMP}`);
    tbody.innerHTML = por_fase.length
      ? por_fase.map((r) => `<tr>
          <td>${esc(PHASE_LABEL[r.phase] || r.phase)}</td>
          <td>${r.sesiones_totales}</td><td>${r.con_features}</td>
          <td>${r.mouse_auc_promedio != null ? r.mouse_auc_promedio : "—"}</td>
          <td>${r.mouse_velocidad_promedio != null ? r.mouse_velocidad_promedio : "—"}</td>
          <td>${r.tecleo_dwell_promedio_ms != null ? Math.round(r.tecleo_dwell_promedio_ms) + "ms" : "—"}</td>
          <td>${r.con_linea_base_personal}</td>
          <td>${r.con_linea_base_poblacional}</td>
        </tr>`).join("")
      : `<tr><td colspan="8" class="hint">Todavía no hay captura registrada para esta campaña.</td></tr>`;
  } catch (e) { tbody.innerHTML = `<tr><td colspan="8" class="hint">Error: ${esc(e.message)}</td></tr>`; }
}
$("#recomputeFeaturesBtn").addEventListener("click", async () => {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  $("#featuresMsg").textContent = "Calculando…";
  try {
    const r = await api("POST", "/api/dashboard/recompute-features", { campaign_id: CURRENT_CAMP });
    $("#featuresMsg").textContent = `Calculadas ${r.computed} sesiones ✓`;
    loadFeaturesSummary();
  } catch (e) { $("#featuresMsg").textContent = "Error: " + e.message; }
});
$("#downloadFeaturesBtn").addEventListener("click", async () => {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  $("#featuresMsg").textContent = "Generando…";
  try {
    const res = await fetch(`/api/export/session-features.csv?campaign_id=${CURRENT_CAMP}`, { headers: { "x-api-key": KEY } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `features_por_sesion_${currentCampaign()?.name || CURRENT_CAMP}.csv`.replace(/[^\w.-]+/g, "_");
    a.click();
    $("#featuresMsg").textContent = "Listo ✓";
  } catch (e) { $("#featuresMsg").textContent = "Error: " + e.message; }
});

/* -------- Captura biométrica facial -------- */
async function loadFacialFeaturesSummary() {
  const tbody = $("#facialTable tbody");
  if (!CURRENT_CAMP) { tbody.innerHTML = `<tr><td colspan="8" class="hint">Elige una campaña en el paso 2.</td></tr>`; return; }
  try {
    const { por_fase } = await api("GET", `/api/dashboard/facial-features-summary?campaign_id=${CURRENT_CAMP}`);
    tbody.innerHTML = por_fase.length
      ? por_fase.map((r) => `<tr>
          <td>${esc(PHASE_LABEL[r.phase] || r.phase)}</td>
          <td>${r.sesiones_totales}</td><td>${r.con_features}</td>
          <td>${r.deteccion_rostro_promedio != null ? Math.round(r.deteccion_rostro_promedio * 100) + "%" : "—"}</td>
          <td>${r.parpadeos_por_min_promedio != null ? r.parpadeos_por_min_promedio : "—"}</td>
          <td>${r.tension_ceja_promedio != null ? r.tension_ceja_promedio : "—"}</td>
          <td>${r.tension_boca_promedio != null ? r.tension_boca_promedio : "—"}</td>
          <td>${r.con_linea_base_personal}</td>
        </tr>`).join("")
      : `<tr><td colspan="8" class="hint">Todavía no hay captura facial registrada para esta campaña (requiere consentimiento de cámara del participante).</td></tr>`;
  } catch (e) { tbody.innerHTML = `<tr><td colspan="8" class="hint">Error: ${esc(e.message)}</td></tr>`; }
}
$("#recomputeFacialFeaturesBtn").addEventListener("click", async () => {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  $("#facialMsg").textContent = "Calculando…";
  try {
    const r = await api("POST", "/api/dashboard/recompute-facial-features", { campaign_id: CURRENT_CAMP });
    $("#facialMsg").textContent = `Calculadas ${r.computed} sesiones ✓`;
    loadFacialFeaturesSummary();
  } catch (e) { $("#facialMsg").textContent = "Error: " + e.message; }
});
async function downloadFacialCsv(path, filenamePrefix) {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  $("#facialMsg").textContent = "Generando…";
  try {
    const res = await fetch(`/api/export/${path}.csv?campaign_id=${CURRENT_CAMP}`, { headers: { "x-api-key": KEY } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${filenamePrefix}_${currentCampaign()?.name || CURRENT_CAMP}.csv`.replace(/[^\w.-]+/g, "_");
    a.click();
    $("#facialMsg").textContent = "Listo ✓";
  } catch (e) { $("#facialMsg").textContent = "Error: " + e.message; }
}
$("#downloadFacialEventsBtn").addEventListener("click", () => downloadFacialCsv("facial-events", "captura_facial"));
$("#downloadFacialFeaturesBtn").addEventListener("click", () => downloadFacialCsv("facial-features", "features_faciales"));

/* -------- Motor de decisión por riesgo (modo sombra) -------- */
async function loadRiskSummary() {
  const tbody = $("#riskTable tbody");
  if (!CURRENT_CAMP) { tbody.innerHTML = `<tr><td colspan="7" class="hint">Elige una campaña en el paso 2.</td></tr>`; return; }
  try {
    const { por_grupo } = await api("GET", `/api/dashboard/risk-summary?campaign_id=${CURRENT_CAMP}`);
    tbody.innerHTML = por_grupo.length
      ? por_grupo.map((r) => `<tr>
          <td>${esc(r.grupo)}</td>
          <td>${r.ataques_totales}</td><td>${r.puntuados}</td><td>${r.con_error}</td>
          <td>${r.riesgo_promedio != null ? r.riesgo_promedio : "—"}</td>
          <td>${r.gate_sombra_habria_mostrado}</td>
          <td>${r.intervencion_mostrada_real}</td>
        </tr>`).join("")
      : `<tr><td colspan="7" class="hint">Todavía no hay ataques enviados en esta campaña.</td></tr>`;
  } catch (e) { tbody.innerHTML = `<tr><td colspan="7" class="hint">Error: ${esc(e.message)}</td></tr>`; }
}

/* -------- Captura conductual (mouse/teclado) -------- */
const PHASE_LABEL = {
  app: "Tablero (TaskFlow)", message: "Mensaje abierto", landing: "Página del ataque",
  calibration: "Calibración", survey: "Encuesta",
};
async function loadBehaviorSummary() {
  const tbody = $("#behTable tbody");
  if (!CURRENT_CAMP) { tbody.innerHTML = `<tr><td colspan="7" class="hint">Elige una campaña en el paso 2.</td></tr>`; return; }
  try {
    const { por_fase } = await api("GET", `/api/dashboard/behavior-summary?campaign_id=${CURRENT_CAMP}`);
    tbody.innerHTML = por_fase.length
      ? por_fase.map((r) => `<tr>
          <td>${esc(PHASE_LABEL[r.phase] || r.phase)}</td>
          <td>${r.sesiones}</td><td>${r.participantes}</td>
          <td>${r.duracion_prom_seg != null ? Math.round(r.duracion_prom_seg) + "s" : "—"}</td>
          <td>${r.mousemove}</td><td>${r.clics}</td><td>${r.teclas}</td>
        </tr>`).join("")
      : `<tr><td colspan="7" class="hint">Todavía no hay captura registrada para esta campaña — ábrele el enlace a un participante y navega un poco.</td></tr>`;
  } catch (e) { tbody.innerHTML = `<tr><td colspan="7" class="hint">Error: ${esc(e.message)}</td></tr>`; }
}
$("#downloadBehaviorBtn").addEventListener("click", async () => {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  $("#behMsg").textContent = "Generando…";
  try {
    const res = await fetch(`/api/export/behavior-events.csv?campaign_id=${CURRENT_CAMP}`, { headers: { "x-api-key": KEY } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `captura_conductual_${currentCampaign()?.name || CURRENT_CAMP}.csv`.replace(/[^\w.-]+/g, "_");
    a.click();
    $("#behMsg").textContent = "Listo ✓";
  } catch (e) { $("#behMsg").textContent = "Error: " + e.message; }
});

/* ================= 6 · INTERACCIÓN (compañeros, tableros, chat, respuestas) ================= */
let CONTACTS = [];
let boardTplColumns = [];
let chatScriptSteps = [];

async function loadInteraction() {
  $("#intNoCamp").hidden = !!CURRENT_CAMP;
  if (!CURRENT_CAMP) {
    $("#contactsTable tbody").innerHTML = "";
    $("#boardTplTable tbody").innerHTML = "";
    $("#chatScriptTable tbody").innerHTML = "";
    $("#branchTable tbody").innerHTML = "";
    $("#credsTable tbody").innerHTML = "";
    return;
  }
  await loadContacts();
  await loadBoardTemplates();
  await loadChatScripts();
  fillBranchTemplateSelects();
  await loadBranches();
  loadCreds();
  loadChannelCounts();
}

/* -------- ataques por canal (correo/tarea/chat directo) -------- */
const CHANNEL_ORDER = ["email", "task", "chat"];
async function loadChannelCounts() {
  const tbody = $("#channelCountTable tbody");
  try {
    const { por_canal } = await api("GET", "/api/dashboard/overview");
    const rows = [...(por_canal || [])].sort(
      (a, b) => CHANNEL_ORDER.indexOf(a.clave) - CHANNEL_ORDER.indexOf(b.clave)
    );
    tbody.innerHTML = rows.length
      ? rows.map((r) => `<tr>
          <td>${esc(KIND_LABEL[r.clave] || r.clave)}</td>
          <td>${r.expuestos}</td><td>${r.abrieron}</td><td>${r.hicieron_clic}</td>
          <td>${r.cayeron}</td><td>${r.reportaron}</td>
          <td>${r.conversion_pct != null ? r.conversion_pct + "%" : "—"}</td>
        </tr>`).join("")
      : `<tr><td colspan="7" class="hint">Todavía no hay ataques enviados por ningún canal.</td></tr>`;
  } catch (e) { tbody.innerHTML = `<tr><td colspan="7" class="hint">Error: ${esc(e.message)}</td></tr>`; }
}

/* -------- compañeros ficticios -------- */
async function loadContacts() {
  const { contacts } = await api("GET", `/api/campaigns/${CURRENT_CAMP}/contacts`);
  CONTACTS = contacts;
  $("#contactsTable tbody").innerHTML = contacts.map((c) => `<tr>
    <td>${esc(c.display_name)}</td><td>${esc(c.role_label || "—")}</td>
    <td><span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${esc(c.avatar_color || "#9aa1ad")}"></span></td>
    <td><button class="btn-xs ghost" data-del-contact="${c.id}">borrar</button></td></tr>`).join("")
    || `<tr><td colspan="4" class="hint">Sin compañeros ficticios todavía.</td></tr>`;
  $$("#contactsTable [data-del-contact]").forEach((b) => b.onclick = async () => {
    if (!confirm("¿Borrar este compañero ficticio?")) return;
    try { await api("DELETE", "/api/contacts/" + b.dataset.delContact); await loadContacts(); renderBoardTplCols(); renderChatScriptSteps(); }
    catch (e) { alert(e.message); }
  });
}
$("#contactForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  const f = e.target;
  try {
    await api("POST", `/api/campaigns/${CURRENT_CAMP}/contacts`, {
      display_name: f.display_name.value.trim(),
      role_label: f.role_label.value.trim() || null,
      avatar_color: f.avatar_color.value,
    });
    f.reset(); f.avatar_color.value = "#4f46e5";
    await loadContacts(); renderBoardTplCols(); renderChatScriptSteps();
  } catch (err) { alert(err.message); }
});
$("#seedContactsBtn").addEventListener("click", async () => {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  $("#seedContactsMsg").textContent = "Creando…";
  try {
    const r = await api("POST", `/api/campaigns/${CURRENT_CAMP}/contacts/seed-defaults`, {});
    const nuevos = r.contacts.filter((c) => !c.skipped).length;
    $("#seedContactsMsg").textContent = nuevos ? `${nuevos} compañeros nuevos ✓` : "Ya estaban todos creados ✓";
    await loadContacts(); renderBoardTplCols(); renderChatScriptSteps();
  } catch (e) { $("#seedContactsMsg").textContent = "Error: " + e.message; }
});

/* -------- plantillas de tablero -------- */
async function loadBoardTemplates() {
  const { board_templates } = await api("GET", `/api/campaigns/${CURRENT_CAMP}/board-templates`);
  $("#boardTplTable tbody").innerHTML = board_templates.map((t) => `<tr>
    <td>${esc(t.name)}</td><td>${(t.seed || []).length}</td>
    <td>${(t.seed || []).reduce((n, col) => n + (col.tasks?.length || 0), 0)}</td>
  </tr>`).join("") || `<tr><td colspan="3" class="hint">Sin plantillas de tablero todavía.</td></tr>`;
}
function renderBoardTplCols() {
  $("#boardTplCols").innerHTML = boardTplColumns.map((col, ci) => `
    <div class="int-col">
      <div class="int-task">
        <strong>Columna ${ci + 1}</strong>
        <input data-path="col:${ci}:name" value="${esc(col.name)}" placeholder="Nombre de columna (ej. Por hacer)" style="flex:1;min-width:160px">
        <button type="button" class="btn-xs ghost" data-remove-col="${ci}">quitar columna</button>
      </div>
      ${col.tasks.map((t, ti) => `
        <div class="int-task">
          <input data-path="col:${ci}:task:${ti}:title" value="${esc(t.title)}" placeholder="Título de la tarea" style="flex:1;min-width:160px">
          <input data-path="col:${ci}:task:${ti}:description" value="${esc(t.description || "")}" placeholder="Descripción (opcional)" style="flex:1;min-width:160px">
          <select data-path="col:${ci}:task:${ti}:responsible_contact_id">
            <option value="">Sin responsable</option>
            ${CONTACTS.map((c) => `<option value="${c.id}" ${t.responsible_contact_id === c.id ? "selected" : ""}>${esc(c.display_name)}</option>`).join("")}
          </select>
          <button type="button" class="btn-xs ghost" data-remove-task="${ci}:${ti}">quitar</button>
        </div>`).join("")}
      <button type="button" class="btn-xs" data-addtask="${ci}">+ Tarea</button>
    </div>`).join("") || `<p class="hint">Añade al menos una columna.</p>`;
}
function setBoardTplPath(path, value) {
  const [, ci, kind, ti, field] = path.split(":");
  if (kind === "name") boardTplColumns[+ci].name = value;
  else if (kind === "task") boardTplColumns[+ci].tasks[+ti][field] = value;
}
$("#boardTplCols").addEventListener("input", (e) => { if (e.target.dataset.path) setBoardTplPath(e.target.dataset.path, e.target.value); });
$("#boardTplCols").addEventListener("change", (e) => { if (e.target.dataset.path) setBoardTplPath(e.target.dataset.path, e.target.value); });
$("#boardTplCols").addEventListener("click", (e) => {
  if (e.target.dataset.removeCol !== undefined) { boardTplColumns.splice(+e.target.dataset.removeCol, 1); renderBoardTplCols(); }
  else if (e.target.dataset.addtask !== undefined) { boardTplColumns[+e.target.dataset.addtask].tasks.push({ title: "", description: "", responsible_contact_id: "" }); renderBoardTplCols(); }
  else if (e.target.dataset.removeTask !== undefined) {
    const [ci, ti] = e.target.dataset.removeTask.split(":").map(Number);
    boardTplColumns[ci].tasks.splice(ti, 1); renderBoardTplCols();
  }
});
$("#boardTplAddCol").addEventListener("click", () => { boardTplColumns.push({ name: "", tasks: [] }); renderBoardTplCols(); });
$("#boardTplSave").addEventListener("click", async () => {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  const name = $("#boardTplName").value.trim();
  if (!name) return alert("Ponle un nombre a la plantilla.");
  const seed = boardTplColumns.filter((c) => c.name.trim()).map((c) => ({
    name: c.name.trim(),
    tasks: c.tasks.filter((t) => t.title.trim()).map((t) => ({
      title: t.title.trim(),
      description: t.description?.trim() || undefined,
      responsible_contact_id: t.responsible_contact_id || undefined,
    })),
  }));
  if (!seed.length) return alert("Añade al menos una columna con nombre.");
  try {
    await api("POST", `/api/campaigns/${CURRENT_CAMP}/board-templates`, { name, seed });
    $("#boardTplName").value = ""; boardTplColumns = []; renderBoardTplCols();
    $("#boardTplMsg").textContent = "Plantilla guardada ✓"; loadBoardTemplates();
  } catch (e) { $("#boardTplMsg").textContent = "Error: " + e.message; }
});
$("#seedBoardTplBtn").addEventListener("click", async () => {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  $("#seedBoardTplMsg").textContent = "Creando…";
  try {
    const r = await api("POST", `/api/campaigns/${CURRENT_CAMP}/board-templates/seed-defaults`, {});
    const nuevas = r.board_templates.filter((t) => !t.skipped && !t.error).length;
    const errores = r.board_templates.filter((t) => t.error);
    $("#seedBoardTplMsg").textContent = errores.length
      ? `Error en "${errores[0].name}": ${errores[0].error}`
      : (nuevas ? `${nuevas} plantillas nuevas ✓` : "Ya estaban todas creadas ✓");
    await loadBoardTemplates(); await loadContacts(); renderBoardTplCols(); renderChatScriptSteps();
  } catch (e) { $("#seedBoardTplMsg").textContent = "Error: " + e.message; }
});

/* -------- guiones de chat -------- */
async function loadChatScripts() {
  const { chat_scripts } = await api("GET", `/api/campaigns/${CURRENT_CAMP}/chat-scripts`);
  $("#chatScriptTable tbody").innerHTML = chat_scripts.map((s) => `<tr>
    <td>${esc(s.name)}</td><td>${(s.script || []).length}</td></tr>`).join("")
    || `<tr><td colspan="2" class="hint">Sin guiones de chat todavía.</td></tr>`;
}
function renderChatScriptSteps() {
  $("#chatScriptSteps").innerHTML = chatScriptSteps.map((s, si) => `
    <div class="int-task">
      <span class="badge ${s.type === "attack" ? "atk" : "benigno"}">${s.type === "attack" ? "ataque" : "mensaje"}</span>
      <select data-path="step:${si}:sender_contact_id">
        <option value="">Sin remitente</option>
        ${CONTACTS.map((c) => `<option value="${c.id}" ${s.sender_contact_id === c.id ? "selected" : ""}>${esc(c.display_name)}</option>`).join("")}
      </select>
      ${s.type === "scripted"
        ? `<input data-path="step:${si}:body" value="${esc(s.body || "")}" placeholder="Qué dice (ej. ¿Ya viste el correo de soporte?)" style="flex:1;min-width:220px">`
        : `<select data-path="step:${si}:template_id">
             <option value="">— elige plantilla de ataque —</option>
             ${TEMPLATES.filter((t) => t.is_attack).map((t) => `<option value="${t.id}" ${s.template_id === t.id ? "selected" : ""}>[${esc(KIND_LABEL[t.kind] || t.kind)}] ${esc(t.name)}</option>`).join("")}
           </select>`}
      <button type="button" class="btn-xs ghost" data-move="${si}:-1" ${si === 0 ? "disabled" : ""}>↑</button>
      <button type="button" class="btn-xs ghost" data-move="${si}:1" ${si === chatScriptSteps.length - 1 ? "disabled" : ""}>↓</button>
      <button type="button" class="btn-xs ghost" data-remove-step="${si}">quitar</button>
    </div>`).join("") || `<p class="hint">Añade al menos un paso.</p>`;
}
function setChatScriptPath(path, value) {
  const [, si, field] = path.split(":");
  chatScriptSteps[+si][field] = value;
}
$("#chatScriptSteps").addEventListener("input", (e) => { if (e.target.dataset.path) setChatScriptPath(e.target.dataset.path, e.target.value); });
$("#chatScriptSteps").addEventListener("change", (e) => { if (e.target.dataset.path) setChatScriptPath(e.target.dataset.path, e.target.value); });
$("#chatScriptSteps").addEventListener("click", (e) => {
  if (e.target.dataset.removeStep !== undefined) { chatScriptSteps.splice(+e.target.dataset.removeStep, 1); renderChatScriptSteps(); }
  else if (e.target.dataset.move !== undefined) {
    const [si, dir] = e.target.dataset.move.split(":").map(Number);
    const nsi = si + dir;
    if (nsi < 0 || nsi >= chatScriptSteps.length) return;
    [chatScriptSteps[si], chatScriptSteps[nsi]] = [chatScriptSteps[nsi], chatScriptSteps[si]];
    renderChatScriptSteps();
  }
});
$("#chatScriptAddScripted").addEventListener("click", () => { chatScriptSteps.push({ type: "scripted", sender_contact_id: "", body: "" }); renderChatScriptSteps(); });
$("#chatScriptAddAttack").addEventListener("click", () => { chatScriptSteps.push({ type: "attack", sender_contact_id: "", template_id: "" }); renderChatScriptSteps(); });
$("#chatScriptSave").addEventListener("click", async () => {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  const name = $("#chatScriptName").value.trim();
  if (!name) return alert("Ponle un nombre al guion.");
  const script = chatScriptSteps.map((s) => s.type === "scripted"
    ? { type: "scripted", sender_contact_id: s.sender_contact_id || undefined, body: (s.body || "").trim() }
    : { type: "attack", sender_contact_id: s.sender_contact_id || undefined, template_id: s.template_id || undefined });
  if (!script.length) return alert("Añade al menos un paso.");
  if (script.some((s) => s.type === "scripted" && !s.body)) return alert("Todo paso de \"mensaje del equipo\" necesita texto.");
  if (script.some((s) => s.type === "attack" && !s.template_id)) return alert("Todo paso de \"insertar ataque\" necesita una plantilla.");
  try {
    await api("POST", `/api/campaigns/${CURRENT_CAMP}/chat-scripts`, { name, script });
    $("#chatScriptName").value = ""; chatScriptSteps = []; renderChatScriptSteps();
    $("#chatScriptMsg").textContent = "Guion guardado ✓"; loadChatScripts();
  } catch (e) { $("#chatScriptMsg").textContent = "Error: " + e.message; }
});
$("#seedChatScriptsBtn").addEventListener("click", async () => {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  $("#seedChatScriptsMsg").textContent = "Creando…";
  try {
    const r = await api("POST", `/api/campaigns/${CURRENT_CAMP}/chat-scripts/seed-defaults`, {});
    const nuevos = r.chat_scripts.filter((s) => !s.skipped).length;
    $("#seedChatScriptsMsg").textContent = r.error
      ? r.error
      : (nuevos ? `${nuevos} guiones nuevos ✓ (${r.chat_scripts.length} en total, uno por cada ataque de chat)` : "Ya estaban todos creados ✓");
    await loadChatScripts(); await loadContacts(); renderBoardTplCols(); renderChatScriptSteps();
  } catch (e) { $("#seedChatScriptsMsg").textContent = "Error: " + e.message; }
});

/* -------- árbol de respuestas -------- */
function fillBranchTemplateSelects() {
  const opts = TEMPLATES.map((t) => `<option value="${t.id}">${t.is_attack ? "[ataque] " : "[relleno] "}${esc(t.name)}</option>`).join("");
  $("#branchFromTpl").innerHTML = `<option value="">— elige —</option>` + opts;
  $("#branchForm [name=to_template_id]").innerHTML = `<option value="">— elige plantilla destino —</option>` + opts;
}
$("#branchFromTpl").addEventListener("change", loadBranches);
async function loadBranches() {
  const fromId = $("#branchFromTpl").value;
  if (!fromId) { $("#branchTable tbody").innerHTML = `<tr><td colspan="4" class="hint">Elige una plantilla de origen arriba.</td></tr>`; return; }
  const { branches } = await api("GET", `/api/templates/${fromId}/branches`);
  $("#branchTable tbody").innerHTML = branches.map((b) => {
    const to = TEMPLATES.find((t) => t.id === b.to_template_id);
    return `<tr><td><code>${esc(b.action_key)}</code></td><td>${esc(b.action_label)}</td><td>${esc(to?.name || b.to_template_id)}</td>
      <td><button class="btn-xs ghost" data-del-branch="${b.id}">borrar</button></td></tr>`;
  }).join("") || `<tr><td colspan="4" class="hint">Sin respuestas configuradas para esta plantilla.</td></tr>`;
  $$("#branchTable [data-del-branch]").forEach((b) => b.onclick = async () => {
    if (!confirm("¿Borrar esta respuesta?")) return;
    try { await api("DELETE", "/api/branches/" + b.dataset.delBranch); loadBranches(); } catch (e) { alert(e.message); }
  });
}
$("#branchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fromId = $("#branchFromTpl").value;
  if (!fromId) return alert("Elige primero la plantilla de origen.");
  const f = e.target;
  try {
    await api("POST", `/api/templates/${fromId}/branches`, {
      action_key: f.action_key.value.trim(), action_label: f.action_label.value.trim(), to_template_id: f.to_template_id.value,
    });
    f.reset(); loadBranches();
  } catch (err) { alert(err.message); }
});

/* -------- credenciales de práctica -------- */
function loadCreds() {
  $("#credsTable tbody").innerHTML = LINKS.map((l) => `<tr data-pcid="${l.id}">
    <td><code>${esc(l.external_hash)}</code></td><td>${esc(l.team_label || "—")}</td>
    <td><input class="cred-user" style="width:100%" placeholder="usuario"></td>
    <td><input class="cred-pass" style="width:100%" placeholder="contraseña"></td>
  </tr>`).join("") || `<tr><td colspan="4" class="hint">Genera los enlaces en el paso 2 primero.</td></tr>`;
}
$("#credsSaveBtn").addEventListener("click", async () => {
  if (!CURRENT_CAMP) return alert("Elige una campaña en el paso 2.");
  const assignments = $$("#credsTable tr[data-pcid]").map((tr) => ({
    participant_campaign_id: tr.dataset.pcid,
    username: tr.querySelector(".cred-user").value.trim(),
    password: tr.querySelector(".cred-pass").value.trim(),
  })).filter((a) => a.username && a.password);
  if (!assignments.length) return alert("Escribe al menos un usuario y una contraseña.");
  try {
    const r = await api("POST", `/api/campaigns/${CURRENT_CAMP}/practice-credentials`, { assignments });
    $("#credsMsg").textContent = `Asignadas a ${r.updated} participante(s) ✓`;
  } catch (e) { $("#credsMsg").textContent = "Error: " + e.message; }
});

/* ================= arranque ================= */
toggleAttackFields(); toggleMsgAttack();
renderBoardTplCols(); renderChatScriptSteps();
if (KEY) $("#connectBtn").click();
