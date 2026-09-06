const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const statusEl = $("#status");
let KEY = sessionStorage.getItem("paws_admin_key") || "";
if (KEY) $("#apiKey").value = KEY;

const VEC_LABEL = { autoridad: "autoridad", urgencia: "urgencia", escasez: "escasez", prueba_social: "prueba social", curiosidad: "curiosidad" };
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
  loadLinks();
  loadPreflight();
  loadMessages();
  markDone("camp", Number(c.links) > 0);
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
    <td>${t.kind === "task" ? "tarea" : "correo"}</td><td>${esc(t.landing_kind)}</td>
    <td><button class="btn-xs" data-edit="${t.id}">editar</button> <button class="btn-xs ghost" data-del="${t.id}">borrar</button></td>
  </tr>`).join("") || `<tr><td colspan="5" class="hint">Sin plantillas de ataque. Pulsa "Crear biblioteca estándar".</td></tr>`;
  $("#tplBenTable tbody").innerHTML = ben.map((t) => `<tr>
    <td>${esc(t.name)}</td><td>${t.kind === "task" ? "tarea" : "correo"}</td><td>${esc(t.sender_label || "—")}</td>
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
  $("#msgTpl").innerHTML = '<option value="">— redactar desde cero —</option>' +
    TEMPLATES.map((t) => `<option value="${t.id}">${t.is_attack ? "[ataque " + (VEC_LABEL[t.vector] || t.vector) + "] " : "[relleno] "}${esc(t.name)}</option>`).join("");
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
    <td>${m.enviados}</td><td>${m.abiertos}</td><td>${m.clics}</td><td>${m.conversiones}</td><td>${m.reportes}</td>
    <td>
      <button class="btn-xs" data-send="${m.id}" data-subj="${esc(m.subject)}" data-atk="${m.is_attack}" data-vec="${esc(m.vector || "")}">enviar</button>
      <button class="btn-xs ghost" data-clone="${m.id}">clonar</button>
      <button class="btn-xs ghost" data-delmsg="${m.id}">borrar</button>
    </td></tr>`).join("") || `<tr><td colspan="9" class="hint">Sin mensajes. Redacta uno arriba.</td></tr>`;
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
  const payload = f.template_id.value
    ? { template_id: f.template_id.value, kind: f.kind.value, subject: f.subject.value || undefined, sender_label: f.sender_label.value || undefined, body: f.body.value || undefined }
    : { kind: f.kind.value, is_attack: isAttack, vector: isAttack ? f.vector.value : undefined, sender_label: f.sender_label.value || null,
        subject: f.subject.value, body: f.body.value || null, cta_label: isAttack ? (f.cta_label.value || "Abrir") : undefined,
        landing_kind: isAttack ? f.landing_kind.value : undefined };
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
  } catch (e) { $("#resCards").innerHTML = `<p class="hint">Error: ${esc(e.message)}</p>`; }
  loadBehaviorSummary();
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

/* ================= arranque ================= */
toggleAttackFields(); toggleMsgAttack();
if (KEY) $("#connectBtn").click();
