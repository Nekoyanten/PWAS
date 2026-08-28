const $status = document.getElementById("status");
let reasonsChart = null;

document.getElementById("loadBtn").addEventListener("click", loadAll);

async function loadAll() {
  const apiKey = document.getElementById("apiKey").value.trim();
  if (!apiKey) {
    $status.textContent = "Ingresa la clave de administrador (ADMIN_API_KEY del .env).";
    return;
  }
  $status.textContent = "Cargando...";
  try {
    const res = await fetch("/api/dashboard/overview", { headers: { "x-api-key": apiKey } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderTotals(data.totales);
    renderTeamTable(data.por_equipo);
    renderFallsDetail(data.motivos_de_caida, data.por_equipo);
    renderRoleVectorTable(data.por_rol_y_escenario);
    renderReasonsChart(data.motivos_de_caida);
    $status.textContent = "Actualizado " + new Date().toLocaleTimeString();
  } catch (err) {
    $status.textContent = "Error: " + err.message + " (¿clave correcta? ¿API corriendo?)";
  }
}

function renderTotals(t) {
  const el = document.getElementById("totalsCards");
  const items = [
    { label: "Total expuestos", value: t.total_expuestos ?? 0 },
    { label: "Total caídos", value: t.total_caidos ?? 0 },
    { label: "Tasa de caída", value: (t.tasa_caida_pct ?? 0) + "%" },
    { label: "Tiempo reacción prom.", value: (t.tiempo_reaccion_promedio_ms ?? "—") + " ms" },
    { label: "Reportaron sospecha", value: t.total_reportes ?? 0 },
    { label: "Permisos concedidos", value: t.total_permisos_concedidos ?? 0 },
    { label: "Reconocieron simulación", value: (t.tasa_reconocimiento_pct ?? 0) + "%" },
  ];
  el.innerHTML = items
    .map((i) => `<div class="card"><div class="value">${i.value}</div><div class="label">${i.label}</div></div>`)
    .join("");
}

function renderTeamTable(rows) {
  const tbody = document.querySelector("#teamTable tbody");
  tbody.innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${r.team_label ?? "(sin asignar)"}</td>
        <td>${r.total_expuestos}</td>
        <td>${r.total_caidos}</td>
        <td>${r.tasa_caida_pct ?? 0}%</td>
      </tr>`
    )
    .join("");
}

function renderFallsDetail(reasons, byTeam) {
  // Reutilizamos /api/dashboard/by-team para el detalle completo (equipo x escenario x motivo)
  fetch("/api/dashboard/by-team", { headers: { "x-api-key": document.getElementById("apiKey").value.trim() } })
    .then((r) => r.json())
    .then((data) => {
      const tbody = document.querySelector("#fallsDetailTable tbody");
      tbody.innerHTML = data.caidas_detalle
        .map(
          (r) => `<tr>
            <td>${r.team_label ?? "(sin asignar)"}</td>
            <td>${r.escenario}</td>
            <td>${r.motivo ?? "no_aplica"}</td>
            <td>${r.participantes_caidos}</td>
          </tr>`
        )
        .join("");
    });
}

function renderRoleVectorTable(rows) {
  const tbody = document.querySelector("#roleVectorTable tbody");
  tbody.innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${r.role}</td>
        <td>${r.vector}</td>
        <td>${r.total_expuestos}</td>
        <td>${r.ctr_pct ?? 0}%</td>
        <td>${r.conversion_pct ?? 0}%</td>
        <td>${r.total_permisos_concedidos ?? 0}</td>
        <td>${r.total_reportes ?? 0}</td>
        <td>${r.tiempo_reaccion_promedio_ms ?? "—"} ms</td>
      </tr>`
    )
    .join("");
}

function renderReasonsChart(rows) {
  const totals = {};
  for (const r of rows) {
    totals[r.fall_reason ?? "no_aplica"] = (totals[r.fall_reason ?? "no_aplica"] || 0) + Number(r.total);
  }
  const labels = Object.keys(totals);
  const values = Object.values(totals);
  const ctx = document.getElementById("reasonsChart");
  if (reasonsChart) reasonsChart.destroy();
  reasonsChart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ label: "Participantes caídos", data: values, backgroundColor: "#2e74b5" }] },
    options: { responsive: true, plugins: { legend: { display: false } } },
  });
}
