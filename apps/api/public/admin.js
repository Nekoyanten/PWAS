// Panel de administración — vanilla JS. Toda petición lleva x-api-key.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const status = $("#status");

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

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---- conexión ----
$("#connectBtn").addEventListener("click", async () => {
  KEY = $("#apiKey").value.trim();
  sessionStorage.setItem("paws_admin_key", KEY);
  try {
    await api("GET", "/api/templates");
    status.textContent = "Conectado ✓";
    refreshAll();
  } catch (e) { status.textContent = "Error: " + e.message; }
});

// ---- tabs ----
$$(".tabs button").forEach((b) => b.addEventListener("click", () => {
  $$(".tabs button").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  $$(".tabpane").forEach((p) => (p.hidden = true));
  $("#tab-" + b.dataset.tab).hidden = false;
}));

function refreshAll() { loadTemplates(); loadCampaigns(); loadParticipants(); }

// ================= PLANTILLAS =================
let TEMPLATES = [];

async function loadTemplates() {
  const { templates } = await api("GET", "/api/templates");
  TEMPLATES = templates;
  const tb = $("#tplTable tbody");
  tb.innerHTML = templates.map((t) => `<tr>
    <td>${esc(t.name)}</td><td>${esc(t.vector)}</td><td>${esc(t.sender_label || "—")}</td>
    <td>${esc(t.landing_kind)}${t.landing_kind === "permiso" && t.landing_config?.permiso ? " · " + esc(t.landing_config.permiso) : ""}</td>
    <td><button class="btn-xs" data-edit="${t.id}">editar</button>
        <button class="btn-xs ghost" data-del="${t.id}">borrar</button></td>
  </tr>`).join("");
  tb.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => editTemplate(b.dataset.edit));
  tb.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    if (!confirm("¿Borrar plantilla?")) return;
    try { await api("DELETE", "/api/templates/" + b.dataset.del); loadTemplates(); }
    catch (e) { alert(e.message); }
  });
  renderCampTplChecks();
}

$("#landingKind").addEventListener("change", (e) => {
  $("#permisoRow").style.display = e.target.value === "permiso" ? "" : "none";
});

$("#seedDefaultsBtn").addEventListener("click", async () => {
  try { await api("POST", "/api/templates/seed-defaults"); loadTemplates(); status.textContent = "Plantillas por defecto creadas ✓"; }
  catch (e) { alert(e.message); }
});

function editTemplate(id) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return;
  const f = $("#tplForm");
  f.id.value = t.id;
  f.name.value = t.name;
  f.vector.value = t.vector;
  f.sender_label.value = t.sender_label || "";
  f.channel.value = t.channel || "web";
  f.subject_or_headline.value = t.subject_or_headline;
  f.message_body.value = t.message_body || "";
  f.cta_label.value = t.cta_label || "";
  f.landing_kind.value = t.landing_kind;
  f.permiso.value = t.landing_config?.permiso || "camara";
  f.landing_titulo.value = t.landing_config?.titulo || "";
  f.landing_detalle.value = t.landing_config?.detalle || "";
  $("#permisoRow").style.display = t.landing_kind === "permiso" ? "" : "none";
  $("#tplFormTitle").textContent = "Editar plantilla";
  $("#tplCancel").style.display = "";
  window.scrollTo(0, document.body.scrollHeight);
}

$("#tplCancel").addEventListener("click", () => resetTplForm());
function resetTplForm() {
  $("#tplForm").reset();
  $("#tplForm").id.value = "";
  $("#tplFormTitle").textContent = "Nueva plantilla";
  $("#tplCancel").style.display = "none";
  $("#permisoRow").style.display = "none";
}

$("#tplForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const landing_config = {};
  if (f.landing_kind.value === "permiso") landing_config.permiso = f.permiso.value;
  if (f.landing_titulo.value) landing_config.titulo = f.landing_titulo.value;
  if (f.landing_detalle.value) landing_config.detalle = f.landing_detalle.value;
  const payload = {
    name: f.name.value, vector: f.vector.value, channel: f.channel.value,
    sender_label: f.sender_label.value || null, subject_or_headline: f.subject_or_headline.value,
    message_body: f.message_body.value || null, cta_label: f.cta_label.value || "Abrir",
    landing_kind: f.landing_kind.value, landing_config,
  };
  try {
    if (f.id.value) await api("PUT", "/api/templates/" + f.id.value, payload);
    else await api("POST", "/api/templates", payload);
    resetTplForm();
    loadTemplates();
    status.textContent = "Plantilla guardada ✓";
  } catch (err) { alert(err.message); }
});

// ================= CAMPAÑAS =================
let CAMPAIGNS = [];
let CURRENT_CAMP = null;

function renderCampTplChecks() {
  $("#campTplChecks").innerHTML = TEMPLATES.map((t) =>
    `<label class="chk"><input type="checkbox" value="${t.id}"> ${esc(t.name)} <em>(${esc(t.vector)})</em></label>`
  ).join("") || '<span class="hint">Crea plantillas primero.</span>';
}

async function loadCampaigns() {
  const { campaigns } = await api("GET", "/api/campaigns");
  CAMPAIGNS = campaigns;
  const tb = $("#campTable tbody");
  tb.innerHTML = campaigns.map((c) => `<tr>
    <td>${esc(c.name)}</td><td>${esc(c.status)}</td><td><code>${esc(c.seed)}</code></td>
    <td>${c.pool_size}</td><td>${c.links}</td><td>${c.delivered}</td>
    <td><button class="btn-xs" data-camp="${c.id}">abrir</button></td>
  </tr>`).join("");
  tb.querySelectorAll("[data-camp]").forEach((b) => b.onclick = () => openCampaign(b.dataset.camp));
}

$("#campForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const template_ids = $$("#campTplChecks input:checked").map((i) => i.value);
  if (template_ids.length === 0) return alert("Selecciona al menos una plantilla para el sorteo.");
  try {
    await api("POST", "/api/campaigns", { name: f.name.value, seed: f.seed.value || undefined, template_ids });
    f.reset();
    loadCampaigns();
    status.textContent = "Campaña creada ✓";
  } catch (err) { alert(err.message); }
});

async function openCampaign(id) {
  CURRENT_CAMP = id;
  const { campaign, assignment_distribution } = await api("GET", "/api/campaigns/" + id);
  $("#campDetailPanel").hidden = false;
  $("#campDetailName").textContent = campaign.name;
  $("#campStatusSel").value = campaign.status;
  $("#campDist").textContent = assignment_distribution.length
    ? "Distribución asignada: " + assignment_distribution.map((d) => `${d.vector}=${d.n}`).join("  ")
    : "Aún no se han generado enlaces.";
  loadLinks(id);
  $("#campDetailPanel").scrollIntoView({ behavior: "smooth" });
}

let LINKS = [];
async function loadLinks(id) {
  const { links } = await api("GET", `/api/campaigns/${id}/links`);
  LINKS = links;
  $("#linksTable tbody").innerHTML = links.map((l) => `<tr>
    <td>${esc(l.external_hash)}</td><td>${esc(l.role)}</td><td>${esc(l.team_label || "—")}</td>
    <td>${esc(l.assigned_vector || "—")}</td><td>${l.delivered_at ? "sí" : "no"}</td>
    <td><a href="${l.url}" target="_blank">${location.origin}${l.url}</a></td>
  </tr>`).join("");
}

$("#genTokensBtn").addEventListener("click", async () => {
  try { const r = await api("POST", `/api/campaigns/${CURRENT_CAMP}/generate-tokens`, {}); status.textContent = `${r.generated} enlaces generados ✓`; openCampaign(CURRENT_CAMP); loadCampaigns(); }
  catch (e) { alert(e.message); }
});
$("#deliverBtn").addEventListener("click", async () => {
  if (!confirm("¿Entregar el estímulo a todos los participantes? A partir de ahora aparece en su bandeja.")) return;
  try { const r = await api("POST", `/api/campaigns/${CURRENT_CAMP}/deliver`, {}); status.textContent = `${r.delivered} estímulos entregados ✓`; openCampaign(CURRENT_CAMP); loadCampaigns(); }
  catch (e) { alert(e.message); }
});
$("#setStatusBtn").addEventListener("click", async () => {
  try { await api("PATCH", `/api/campaigns/${CURRENT_CAMP}/status`, { status: $("#campStatusSel").value }); status.textContent = "Estado actualizado ✓"; loadCampaigns(); }
  catch (e) { alert(e.message); }
});
$("#copyLinksBtn").addEventListener("click", () => {
  const txt = LINKS.map((l) => `${l.external_hash}\t${location.origin}${l.url}`).join("\n");
  navigator.clipboard.writeText(txt).then(() => status.textContent = "Enlaces copiados ✓");
});
$("#downloadLinksBtn").addEventListener("click", () => {
  const rows = [["external_hash", "role", "team_label", "assigned_vector", "url"]]
    .concat(LINKS.map((l) => [l.external_hash, l.role, l.team_label || "", l.assigned_vector || "", location.origin + l.url]));
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "enlaces_campana.csv";
  a.click();
});

// ================= PARTICIPANTES =================
async function loadParticipants() {
  const { participants } = await api("GET", "/api/participants");
  $("#partCount").textContent = participants.length;
  $("#partTable tbody").innerHTML = participants.map((p) => `<tr>
    <td>${esc(p.external_hash)}</td><td>${esc(p.role)}</td><td>${esc(p.team_label || "—")}</td>
    <td>${esc(p.group_assignment || "—")}</td><td>${p.consent_given ? "sí" : "no"}</td>
  </tr>`).join("");
}

$("#importCsvBtn").addEventListener("click", async () => {
  try { const r = await api("POST", "/api/participants/import-csv", $("#csvBox").value, true);
    $("#importMsg").textContent = `Importados ${r.imported}, fallidos ${r.failed}.`;
    loadParticipants();
  } catch (e) { $("#importMsg").textContent = "Error: " + e.message; }
});
$("#importJsonBtn").addEventListener("click", async () => {
  try {
    const r = await api("POST", "/api/participants/import", JSON.parse($("#jsonBox").value));
    $("#importMsg").textContent = `Importados ${r.imported}, fallidos ${r.failed}.`;
    loadParticipants();
  } catch (e) { $("#importMsg").textContent = "Error: " + e.message; }
});

// autoconectar si ya hay clave guardada
if (KEY) $("#connectBtn").click();
