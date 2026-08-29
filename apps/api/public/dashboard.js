const $ = (s) => document.querySelector(s);
const $status = $("#status");
let charts = {};
let timer = null;

const KEY_STORE = "paws_admin_key";
if (sessionStorage.getItem(KEY_STORE)) $("#apiKey").value = sessionStorage.getItem(KEY_STORE);

const VEC_LABEL = { autoridad: "Autoridad", urgencia: "Urgencia", escasez: "Escasez", prueba_social: "Prueba social", curiosidad: "Curiosidad" };
const ROLE_LABEL = { estudiante: "Estudiantes", profesor: "Profesores", directivo: "Directivos" };
const REASON_LABEL = {
  no_aplica: "No actué",
  miedo_sancion: "Miedo a una sanción",
  promesa_beneficio: "Promesa de un beneficio",
  confianza_remitente: "Confié en quién lo enviaba",
  urgencia_temporal: "La urgencia / poco tiempo",
  prueba_social: "Otros ya lo habían hecho",
  curiosidad: "Curiosidad",
};
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const num = (x) => Number(x ?? 0);

$("#loadBtn").addEventListener("click", loadAll);
$("#autoChk").addEventListener("change", scheduleAuto);

async function loadAll() {
  const apiKey = $("#apiKey").value.trim();
  if (!apiKey) { $status.textContent = "Ingresa la clave de administrador (ADMIN_API_KEY del .env)."; return; }
  sessionStorage.setItem(KEY_STORE, apiKey);
  $status.textContent = "Cargando…";
  try {
    const res = await fetch("/api/dashboard/overview", { headers: { "x-api-key": apiKey } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    renderTotals(d);
    renderReadout(d);
    renderFunnel(d.embudo || {});
    renderTecnica(d.por_tecnica || []);
    renderRol(d.por_rol || []);
    renderReasons(d.motivos_de_caida || []);
    renderTeam(d.por_equipo || []);
    $status.textContent = "Actualizado " + new Date().toLocaleTimeString();
    scheduleAuto();
  } catch (err) {
    $status.textContent = "Error: " + err.message + " (¿clave correcta? ¿API corriendo?)";
  }
}

function scheduleAuto() {
  if (timer) { clearTimeout(timer); timer = null; }
  if ($("#autoChk").checked) timer = setTimeout(loadAll, 8000);
}

function renderTotals(d) {
  const f = d.embudo || {}, p = d.percepcion || {}, t = d.totales || {};
  const items = [
    { value: num(f.recibieron), label: "Recibieron el ataque" },
    { value: num(f.cayeron), sub: pct(num(f.cayeron), num(f.recibieron)) + "% de los expuestos", label: "Cayeron" },
    { value: num(f.reportaron), sub: pct(num(f.reportaron), num(f.recibieron)) + "%", label: "Lo reportaron como sospechoso" },
    { value: (p.sospecharon_pct ?? 0) + "%", label: "Sospecharon antes de actuar" },
    { value: (p.reconocieron_pct ?? 0) + "%", label: "Reconocieron que era simulación" },
    { value: (t.tiempo_reaccion_promedio_ms ? Math.round(t.tiempo_reaccion_promedio_ms / 1000) + " s" : "—"), label: "Tiempo medio hasta el clic" },
  ];
  $("#totalsCards").innerHTML = items.map((i) => `
    <div class="card"><div class="value">${i.value}</div>${i.sub ? `<div class="sub">${i.sub}</div>` : ""}<div class="label">${i.label}</div></div>`).join("");
}

function renderReadout(d) {
  const f = d.embudo || {};
  const el = $("#readout");
  if (!num(f.recibieron)) { el.className = "readout"; el.textContent = "Todavía no se ha entregado ningún mensaje de ataque."; return; }
  const tec = [...(d.por_tecnica || [])].filter((r) => num(r.expuestos)).sort((a, b) => num(b.conversion_pct) - num(a.conversion_pct));
  const rol = [...(d.por_rol || [])].filter((r) => num(r.expuestos)).sort((a, b) => num(b.conversion_pct) - num(a.conversion_pct));
  const reasons = {};
  for (const r of d.motivos_de_caida || []) reasons[r.fall_reason] = (reasons[r.fall_reason] || 0) + num(r.total);
  const topReason = Object.entries(reasons).filter(([k]) => k && k !== "no_aplica").sort((a, b) => b[1] - a[1])[0];
  const parts = [];
  parts.push(`Cayeron <strong>${num(f.cayeron)} de ${num(f.recibieron)}</strong> (${pct(num(f.cayeron), num(f.recibieron))}%).`);
  if (tec[0]) parts.push(`La técnica con más caídas fue <strong>${VEC_LABEL[tec[0].clave] || tec[0].clave}</strong> (${num(tec[0].conversion_pct)}%)${tec.length > 1 ? `; la que menos, ${VEC_LABEL[tec[tec.length - 1].clave] || tec[tec.length - 1].clave} (${num(tec[tec.length - 1].conversion_pct)}%)` : ""}.`);
  if (rol[0] && rol.length > 1) parts.push(`Por rol, ${ROLE_LABEL[rol[0].clave] || rol[0].clave} fueron los más susceptibles (${num(rol[0].conversion_pct)}%).`);
  if (topReason) parts.push(`El motivo más citado por quienes cayeron: “${REASON_LABEL[topReason[0]] || topReason[0]}”.`);
  if (d.percepcion) parts.push(`El ${d.percepcion.reconocieron_pct ?? 0}% se dio cuenta de que era una prueba.`);
  el.className = "readout";
  el.innerHTML = parts.join(" ");
}

function renderFunnel(f) {
  const steps = [
    { name: "Recibieron", v: num(f.recibieron) },
    { name: "Abrieron", v: num(f.abrieron) },
    { name: "Hicieron clic", v: num(f.hicieron_clic) },
    { name: "Cayeron", v: num(f.cayeron) },
  ];
  const max = steps[0].v || 1;
  $("#funnel").innerHTML = steps.map((s, i) => {
    const w = Math.max((s.v / max) * 100, s.v ? 6 : 0);
    const rel = i === 0 ? "" : ` · ${pct(s.v, steps[i - 1].v)}% del paso anterior`;
    return `<div class="row">
      <span class="name">${s.name}</span>
      <span class="track"><span class="fill step${i}" style="width:${w}%">${s.v}</span></span>
      <span class="pct">${pct(s.v, max)}% del total${rel}</span>
    </div>`;
  }).join("");
}

function bar(id, labels, data, label) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($("#" + id), {
    type: "bar",
    data: { labels, datasets: [{ label, data, backgroundColor: "#2e74b5" }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, title: { display: true, text: "%" } } } },
  });
}

function renderTecnica(rows) {
  const r = [...rows].filter((x) => num(x.expuestos)).sort((a, b) => num(b.conversion_pct) - num(a.conversion_pct));
  bar("tecnicaChart", r.map((x) => VEC_LABEL[x.clave] || x.clave), r.map((x) => num(x.conversion_pct)), "Conversión %");
  $("#tecnicaTable tbody").innerHTML = r.map((x) => `<tr>
    <td>${VEC_LABEL[x.clave] || x.clave}</td><td>${num(x.expuestos)}</td><td>${num(x.abrieron)}</td>
    <td>${num(x.hicieron_clic)} (${num(x.clic_pct)}%)</td><td>${num(x.cayeron)}</td>
    <td><strong>${num(x.conversion_pct)}%</strong></td><td>${num(x.reportaron)}</td></tr>`).join("")
    || `<tr><td colspan="7" class="hint">Sin datos todavía.</td></tr>`;
}

function renderRol(rows) {
  const r = [...rows].filter((x) => num(x.expuestos)).sort((a, b) => num(b.conversion_pct) - num(a.conversion_pct));
  bar("rolChart", r.map((x) => ROLE_LABEL[x.clave] || x.clave), r.map((x) => num(x.conversion_pct)), "Conversión %");
  $("#rolTable tbody").innerHTML = r.map((x) => `<tr>
    <td>${ROLE_LABEL[x.clave] || x.clave}</td><td>${num(x.expuestos)}</td>
    <td>${num(x.hicieron_clic)} (${num(x.clic_pct)}%)</td><td>${num(x.cayeron)}</td>
    <td><strong>${num(x.conversion_pct)}%</strong></td></tr>`).join("")
    || `<tr><td colspan="5" class="hint">Sin datos todavía.</td></tr>`;
}

function renderReasons(rows) {
  const totals = {};
  for (const r of rows) {
    const k = r.fall_reason || "no_aplica";
    if (k === "no_aplica") continue;
    totals[k] = (totals[k] || 0) + num(r.total);
  }
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (charts.reasonsChart) charts.reasonsChart.destroy();
  charts.reasonsChart = new Chart($("#reasonsChart"), {
    type: "bar",
    data: { labels: entries.map(([k]) => REASON_LABEL[k] || k), datasets: [{ label: "Personas", data: entries.map(([, v]) => v), backgroundColor: "#c2410c" }] },
    options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
  });
}

function renderTeam(rows) {
  $("#teamTable tbody").innerHTML = rows.map((r) => `<tr>
    <td>${r.team_label ?? "(sin asignar)"}</td><td>${num(r.total_expuestos)}</td>
    <td>${num(r.total_caidos)}</td><td>${num(r.tasa_caida_pct)}%</td></tr>`).join("")
    || `<tr><td colspan="4" class="hint">Sin datos todavía.</td></tr>`;
}

if ($("#apiKey").value) loadAll();
