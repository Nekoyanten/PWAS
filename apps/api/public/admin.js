const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const statusEl = $("#status");
let KEY = sessionStorage.getItem("paws_admin_key") || "";
if (KEY) $("#apiKey").value = KEY;

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
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

$("#connectBtn").addEventListener("click", async () => {
  KEY = $("#apiKey").value.trim();
  sessionStorage.setItem("paws_admin_key", KEY);
  try { await api("GET", "/api/templates"); statusEl.textContent = "Conectado ✓"; refreshAll(); }
  catch (e) { statusEl.textContent = "Error: " + e.message; }
});

$$(".tabs button").forEach((b) => b.addEventListener("click", () => {
  $$(".tabs button").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  $$(".tabpane").forEach((p) => (p.hidden = true));
  $("#tab-" + b.dataset.tab).hidden = false;
}));

function refreshAll() { loadTemplates(); loadCampaigns(); loadParticipants(); loadMsgCampaigns(); }

/* ================= PLANTILLAS ================= */
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
  $("#tplTable tbody").innerHTML = templates.map((t) => `<tr>
    <td>${esc(t.name)}</td><td>${t.kind === "task" ? "tarea" : "correo"}</td>
    <td>${t.is_attack ? "sí" : "no"}</td><td>${t.is_attack ? esc(t.vector) : "—"}</td>
    <td>${t.is_attack ? esc(t.landing_kind) : "—"}</td>
    <td><button class="btn-xs" data-edit="${t.id}">editar</button> <button class="btn-xs ghost" data-del="${t.id}">borrar</button></td>
  </tr>`).join("");
  $$("#tplTable [data-edit]").forEach((b) => b.onclick = () => editTemplate(b.dataset.edit));
  $$("#tplTable [data-del]").forEach((b) => b.onclick = async () => {
    if (confirm("¿Borrar plantilla?")) { try { await api("DELETE", "/api/templates/" + b.dataset.del); loadTemplates(); } catch (e) { alert(e.message); } }
  });
  renderCampTplChecks();
  fillMsgTemplateSelect();
}

$("#seedDefaultsBtn").addEventListener("click", async () => {
  try { await api("POST", "/api/templates/seed-defaults"); loadTemplates(); statusEl.textContent = "Juego estándar creado ✓"; }
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
  window.scrollTo(0, document.body.scrollHeight);
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

/* ================= CAMPAÑAS ================= */
let CAMPAIGNS = [], CURRENT_CAMP = null, LINKS = [];
function renderCampTplChecks() {
  $("#campTplChecks").innerHTML = TEMPLATES.map((t) =>
    `<label class="chk"><input type="checkbox" value="${t.id}"> ${esc(t.name)} <em>(${t.is_attack ? esc(t.vector) : "benigno"})</em></label>`
  ).join("") || '<span class="hint">Crea plantillas primero.</span>';
}
async function loadCampaigns() {
  const { campaigns } = await api("GET", "/api/campaigns");
  CAMPAIGNS = campaigns;
  $("#campTable tbody").innerHTML = campaigns.map((c) => `<tr>
    <td>${esc(c.name)}</td><td>${esc(c.status)}</td><td><code>${esc(c.seed)}</code></td>
    <td>${c.links}</td><td>${c.messages}</td><td>${c.deliveries}</td>
    <td><button class="btn-xs" data-camp="${c.id}">abrir</button></td>
  </tr>`).join("");
  $$("#campTable [data-camp]").forEach((b) => b.onclick = () => openCampaign(b.dataset.camp));
  loadMsgCampaigns();
}
$("#campForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const template_ids = $$("#campTplChecks input:checked").map((i) => i.value);
  try {
    await api("POST", "/api/campaigns", { name: e.target.name.value, seed: e.target.seed.value || undefined, template_ids });
    e.target.reset(); loadCampaigns(); statusEl.textContent = "Campaña creada ✓";
  } catch (err) { alert(err.message); }
});
async function openCampaign(id) {
  CURRENT_CAMP = id;
  const { campaign } = await api("GET", "/api/campaigns/" + id);
  const { teams } = await api("GET", `/api/campaigns/${id}/teams`);
  $("#campDetailPanel").hidden = false;
  $("#campDetailName").textContent = campaign.name;
  $("#campStatusSel").value = campaign.status;
  $("#campTeams").textContent = teams.map((t) => `${t.team_label} (${t.participantes})`).join(", ") || "sin participantes con enlace";
  loadLinks(id);
  $("#campDetailPanel").scrollIntoView({ behavior: "smooth" });
}
async function loadLinks(id) {
  const { links } = await api("GET", `/api/campaigns/${id}/links`);
  LINKS = links;
  $("#linksTable tbody").innerHTML = links.map((l) => `<tr>
    <td>${esc(l.external_hash)}</td><td>${esc(l.role)}</td><td>${esc(l.team_label || "—")}</td>
    <td>${l.mensajes}</td><td>${l.encuesta ? "sí" : "no"}</td>
    <td><a href="${l.url}" target="_blank">${location.origin}${l.url}</a></td>
    <td><button class="btn-xs ghost" data-reset="${l.id}">reiniciar</button></td>
  </tr>`).join("");
  $$("#linksTable [data-reset]").forEach((b) => b.onclick = async () => {
    if (confirm("¿Reiniciar este participante? Borra sus eventos y encuesta.")) {
      try { await api("POST", `/api/campaigns/${CURRENT_CAMP}/participants/${b.dataset.reset}/reset`); loadLinks(CURRENT_CAMP); }
      catch (e) { alert(e.message); }
    }
  });
}
$("#genTokensBtn").addEventListener("click", async () => {
  try { const r = await api("POST", `/api/campaigns/${CURRENT_CAMP}/generate-tokens`, {}); statusEl.textContent = `${r.generated} enlaces ✓`; openCampaign(CURRENT_CAMP); loadCampaigns(); }
  catch (e) { alert(e.message); }
});
$("#setStatusBtn").addEventListener("click", async () => {
  try { await api("PATCH", `/api/campaigns/${CURRENT_CAMP}/status`, { status: $("#campStatusSel").value }); statusEl.textContent = "Estado actualizado ✓"; loadCampaigns(); }
  catch (e) { alert(e.message); }
});
$("#resetCampBtn").addEventListener("click", async () => {
  if (!confirm("¿Reiniciar TODA la campaña? Borra eventos, envíos y encuestas de todos (conserva participantes y mensajes).")) return;
  try { const r = await api("POST", `/api/campaigns/${CURRENT_CAMP}/reset`); statusEl.textContent = `Reiniciados ${r.reset} ✓`; openCampaign(CURRENT_CAMP); }
  catch (e) { alert(e.message); }
});
$("#copyLinksBtn").addEventListener("click", () => {
  navigator.clipboard.writeText(LINKS.map((l) => `${l.external_hash}\t${location.origin}${l.url}`).join("\n"))
    .then(() => statusEl.textContent = "Enlaces copiados ✓");
});
$("#downloadLinksBtn").addEventListener("click", () => {
  const rows = [["external_hash", "role", "team_label", "url"]].concat(LINKS.map((l) => [l.external_hash, l.role, l.team_label || "", location.origin + l.url]));
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "enlaces.csv"; a.click();
});

/* ================= MENSAJES ================= */
let MSG_CAMP = null, CURRENT_MSG = null;
function fillMsgTemplateSelect() {
  $("#msgTpl").innerHTML = '<option value="">— redactar desde cero —</option>' +
    TEMPLATES.map((t) => `<option value="${t.id}">${esc(t.name)}${t.is_attack ? ` (${esc(t.vector)})` : " (benigno)"}</option>`).join("");
}
function loadMsgCampaigns() {
  $("#msgCampSel").innerHTML = CAMPAIGNS.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  if (CAMPAIGNS[0]) { MSG_CAMP = $("#msgCampSel").value = MSG_CAMP && CAMPAIGNS.find((c) => c.id === MSG_CAMP) ? MSG_CAMP : CAMPAIGNS[0].id; loadMessages(); }
}
$("#msgCampSel").addEventListener("change", (e) => { MSG_CAMP = e.target.value; loadMessages(); });
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
  if (!MSG_CAMP) return;
  const { messages } = await api("GET", `/api/campaigns/${MSG_CAMP}/messages`);
  $("#msgTable tbody").innerHTML = messages.map((m) => `<tr>
    <td>${esc(m.subject)}</td><td>${m.kind === "task" ? "tarea" : "correo"}</td><td>${m.is_attack ? "sí" : "no"}</td>
    <td>${m.is_attack ? esc(m.vector) : "—"}</td><td>${m.enviados}</td><td>${m.abiertos}</td><td>${m.clics}</td>
    <td>${m.conversiones}</td><td>${m.reportes}</td>
    <td>
      <button class="btn-xs" data-send="${m.id}" data-subj="${esc(m.subject)}">enviar</button>
      <button class="btn-xs ghost" data-clone="${m.id}">clonar</button>
      <button class="btn-xs ghost" data-delmsg="${m.id}">borrar</button>
    </td></tr>`).join("");
  $$("#msgTable [data-send]").forEach((b) => b.onclick = () => openSend(b.dataset.send, b.dataset.subj));
  $$("#msgTable [data-clone]").forEach((b) => b.onclick = async () => { try { await api("POST", `/api/messages/${b.dataset.clone}/clone`); loadMessages(); } catch (e) { alert(e.message); } });
  $$("#msgTable [data-delmsg]").forEach((b) => b.onclick = async () => { if (confirm("¿Borrar mensaje y sus envíos?")) { try { await api("DELETE", `/api/messages/${b.dataset.delmsg}`); loadMessages(); } catch (e) { alert(e.message); } } });
}
$("#msgForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const isAttack = f.is_attack.value === "true";
  const payload = f.template_id.value
    ? { template_id: f.template_id.value, kind: f.kind.value, subject: f.subject.value || undefined, sender_label: f.sender_label.value || undefined, body: f.body.value || undefined }
    : { kind: f.kind.value, is_attack: isAttack, vector: isAttack ? f.vector.value : undefined, sender_label: f.sender_label.value || null,
        subject: f.subject.value, body: f.body.value || null, cta_label: isAttack ? (f.cta_label.value || "Abrir") : undefined,
        landing_kind: isAttack ? f.landing_kind.value : undefined };
  try { await api("POST", `/api/campaigns/${MSG_CAMP}/messages`, payload); f.reset(); toggleMsgAttack(); loadMessages(); loadCampaigns(); statusEl.textContent = "Mensaje guardado ✓"; }
  catch (err) { alert(err.message); }
});
async function openSend(id, subject) {
  CURRENT_MSG = id;
  $("#sendPanel").hidden = false;
  $("#sendMsgSubject").textContent = subject;
  const { teams } = await api("GET", `/api/campaigns/${MSG_CAMP}/teams`);
  $("#sendTeams").innerHTML = teams.map((t) => `<label class="chk"><input type="checkbox" value="${esc(t.team_label)}"> ${esc(t.team_label)} (${t.participantes})</label>`).join("")
    || '<span class="hint">No hay participantes con enlace en esta campaña.</span>';
  $("#sendMsg").textContent = "";
  $("#sendPanel").scrollIntoView({ behavior: "smooth" });
}
$("#sendGoBtn").addEventListener("click", async () => {
  const team_labels = $$("#sendTeams input:checked").map((i) => i.value);
  if (!team_labels.length) return alert("Marca al menos un equipo.");
  try { const r = await api("POST", `/api/messages/${CURRENT_MSG}/send`, { team_labels }); $("#sendMsg").textContent = `Enviado a ${r.delivered} (${r.skipped} ya lo tenían).`; loadMessages(); loadCampaigns(); }
  catch (e) { alert(e.message); }
});
$("#sendAllBtn").addEventListener("click", async () => {
  if (!confirm("¿Enviar a TODA la campaña?")) return;
  try { const r = await api("POST", `/api/messages/${CURRENT_MSG}/send`, { all: true }); $("#sendMsg").textContent = `Enviado a ${r.delivered} (${r.skipped} ya lo tenían).`; loadMessages(); loadCampaigns(); }
  catch (e) { alert(e.message); }
});

/* ================= PARTICIPANTES ================= */
async function loadParticipants() {
  const { participants } = await api("GET", "/api/participants");
  $("#partCount").textContent = participants.length;
  $("#partTable tbody").innerHTML = participants.map((p) => `<tr>
    <td>${esc(p.external_hash)}</td><td>${esc(p.role)}</td><td>${esc(p.team_label || "—")}</td>
    <td>${esc(p.group_assignment || "—")}</td><td>${p.consent_given ? "sí" : "no"}</td></tr>`).join("");
}
$("#importCsvBtn").addEventListener("click", async () => {
  try { const r = await api("POST", "/api/participants/import-csv", $("#csvBox").value, true); $("#importMsg").textContent = `Importados ${r.imported}, fallidos ${r.failed}.`; loadParticipants(); }
  catch (e) { $("#importMsg").textContent = "Error: " + e.message; }
});
$("#importJsonBtn").addEventListener("click", async () => {
  try { const r = await api("POST", "/api/participants/import", JSON.parse($("#jsonBox").value)); $("#importMsg").textContent = `Importados ${r.imported}, fallidos ${r.failed}.`; loadParticipants(); }
  catch (e) { $("#importMsg").textContent = "Error: " + e.message; }
});

toggleAttackFields(); toggleMsgAttack();
if (KEY) $("#connectBtn").click();
