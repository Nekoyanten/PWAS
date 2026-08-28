// Renderizado de la app señuelo "TaskFlow" y de las pantallas del flujo del
// participante. Marca deliberadamente GENÉRICA y FICTICIA (PS §3.2).
//
// Todo el estado del participante viaja en el token de la URL. Ninguna
// pantalla captura contenido escrito por el participante.

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// HTML simple permitido en el cuerpo de los mensajes (contenido de admin),
// saneado a una lista blanca mínima.
function sanitizeMessageHtml(html) {
  if (!html) return "";
  let out = escapeHtml(html);
  out = out
    .replace(/&lt;(\/?(?:b|strong|i|em|u|p|br|ul|ol|li|span|h3|h4))&gt;/gi, "<$1>")
    .replace(/\n/g, "<br>");
  return out;
}

function shell(title, bodyHtml, extraHead = "") {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${BASE_CSS}</style>${extraHead}</head><body>${bodyHtml}</body></html>`;
}

const BASE_CSS = `
:root{
  --bg:#f6f7f9; --surface:#ffffff; --line:#e6e8ec; --ink:#1c2128; --muted:#6b7280;
  --brand:#4f46e5; --brand-ink:#4338ca; --accent:#0ea5a4; --warn:#dc2626;
  --radius:12px; --shadow:0 1px 2px rgba(16,24,40,.06),0 8px 24px rgba(16,24,40,.06);
}
*{box-sizing:border-box}
body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
a{color:var(--brand);text-decoration:none}
a:hover{color:var(--brand-ink)}
.btn{display:inline-flex;align-items:center;gap:.4rem;background:var(--brand);color:#fff;border:none;border-radius:9px;padding:.6rem 1.1rem;font:inherit;font-weight:600;font-size:.92rem;cursor:pointer}
.btn:hover{background:var(--brand-ink)}
.btn.ghost{background:#eef0f4;color:var(--ink)}
.btn.ghost:hover{background:#e2e5ea}
.btn.subtle{background:transparent;color:var(--muted);font-weight:500}

/* topbar */
.tf-top{background:var(--surface);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:1rem;padding:.7rem 1.15rem;position:sticky;top:0;z-index:5}
.tf-logo{display:flex;align-items:center;gap:.5rem;font-weight:700;font-size:1rem;letter-spacing:-.01em}
.tf-logo svg{width:22px;height:22px}
.tf-top .spacer{flex:1}
.tf-chip{display:inline-flex;align-items:center;gap:.4rem;background:#eef0f4;border-radius:8px;padding:.4rem .7rem;font-size:.86rem;color:var(--muted);border:none;cursor:pointer}
.tf-chip .dot{width:7px;height:7px;border-radius:50%;background:var(--warn)}

/* board */
.tf-wrap{display:flex;gap:1.15rem;padding:1.15rem;max-width:1240px;margin:0 auto;align-items:flex-start}
.tf-board{flex:1;display:flex;gap:1rem;overflow-x:auto;padding-bottom:.5rem}
.tf-col{background:#eef0f3;border-radius:var(--radius);padding:.7rem;min-width:255px;flex:1}
.tf-col h3{margin:.15rem .35rem .65rem;font-size:.76rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
.tf-card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:.7rem .8rem;margin-bottom:.55rem;box-shadow:var(--shadow);font-size:.9rem;cursor:grab}
.tf-card:active{cursor:grabbing}
.tf-card .tag{display:inline-block;font-size:.7rem;font-weight:600;padding:.1rem .5rem;border-radius:20px;margin-top:.45rem}
.tag.dev{background:#e8ecfd;color:#3538cd}.tag.doc{background:#e4f6ec;color:#137a45}.tag.ops{background:#fdeede;color:#a55b12}

/* inbox */
.tf-side{width:360px;flex-shrink:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}
.tf-side h2{margin:0;padding:.85rem 1rem;font-size:.92rem;font-weight:600;border-bottom:1px solid var(--line)}
.msg{display:block;padding:.8rem 1rem;border-bottom:1px solid var(--line);cursor:pointer}
.msg:last-child{border-bottom:none}
.msg:hover{background:#fafbfc}
.msg .row1{display:flex;justify-content:space-between;align-items:baseline;gap:.5rem}
.msg .from{font-weight:600;font-size:.88rem}
.msg .kind{font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:.05rem .35rem}
.msg .subj{font-size:.87rem;color:#33415c;margin-top:.15rem}
.msg .prev{font-size:.8rem;color:var(--muted);margin-top:.1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msg.unread .from::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--brand);margin-right:.4rem;vertical-align:middle}

/* centered cards */
.center,.card-view,.debrief{max-width:560px;margin:2.5rem auto;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:1.9rem 2rem}
.card-view{max-width:660px}
.debrief{max-width:680px;line-height:1.65}
.center h1,.card-view h1,.debrief h1{font-size:1.3rem;margin:.1rem 0 .5rem;letter-spacing:-.01em}
.card-view .meta{font-size:.82rem;color:var(--muted);margin-bottom:1rem}
.card-view .body{font-size:.95rem;line-height:1.6}
.note{font-size:.8rem;color:var(--muted);margin-top:1.2rem}

/* task detail */
.task-detail{max-width:620px;margin:2.5rem auto;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}
.task-detail .head{padding:1rem 1.4rem;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:.6rem}
.task-detail .head .tag{font-size:.7rem;font-weight:600;padding:.1rem .5rem;border-radius:20px;background:#fdeede;color:#a55b12}
.task-detail .b{padding:1.3rem 1.4rem;font-size:.95rem;line-height:1.6}

/* forms */
.field{display:block;margin:.8rem 0}
.field label{display:block;font-size:.82rem;color:#41506b;margin-bottom:.3rem;font-weight:500}
.field input,.field select,.field textarea{width:100%;padding:.6rem .65rem;border:1px solid var(--line);border-radius:9px;font:inherit;font-size:.95rem}
fieldset{border:1px solid var(--line);border-radius:11px;margin:1rem 0;padding:.85rem 1.05rem}
fieldset legend{font-size:.88rem;font-weight:600;color:#41506b;padding:0 .35rem}
.opt{display:block;margin:.4rem 0;font-size:.92rem}

/* auth dialog (simulado) */
.perm{max-width:430px;margin:3.5rem auto;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:0 12px 48px rgba(16,24,40,.18);overflow:hidden}
.perm .head{padding:1.15rem 1.3rem;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:.55rem;font-weight:700}
.perm .body{padding:1.2rem 1.3rem;font-size:.92rem;line-height:1.55;color:#33415c}
.perm .scopes{list-style:none;margin:.9rem 0 0;padding:0}
.perm .scopes li{display:flex;gap:.55rem;align-items:flex-start;padding:.4rem 0;font-size:.9rem}
.perm .scopes svg{width:17px;height:17px;color:var(--accent);flex-shrink:0;margin-top:.1rem}
.perm .actions{display:flex;gap:.55rem;justify-content:flex-end;padding:1rem 1.3rem;background:#fafbfc;border-top:1px solid var(--line)}
`;

const LOGO_SVG = `<svg viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="5" fill="#4f46e5"/><path d="M7 12.5l3 3 7-7" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

// ---------------------------------------------------------------------------
// 1) Bienvenida + consentimiento.
export function renderWelcome(token, campaignName) {
  return shell("TaskFlow — Piloto de usabilidad", `
<div class="center">
  <div class="tf-logo" style="margin-bottom:1.1rem">${LOGO_SVG} TaskFlow</div>
  <h1>Piloto de usabilidad</h1>
  <p>Gracias por ayudarnos a evaluar <strong>TaskFlow</strong>, un organizador de
  tareas en desarrollo. Te pediremos usar la aplicación con normalidad durante unos
  minutos: revisar tus tarjetas, tu bandeja de mensajes y organizar tu trabajo como
  cualquier día.</p>
  <p>La sesión es <strong>anónima</strong>: no se registra tu nombre ni el contenido
  de lo que escribas, solo cómo interactúas con la interfaz. Al terminar te haremos
  unas preguntas breves.</p>
  <form method="POST" action="/t/${encodeURIComponent(token)}/consent">
    <label class="opt"><input type="checkbox" name="consent" value="1" required>
      He leído lo anterior y acepto participar.</label>
    <p style="margin-top:1.1rem"><button class="btn" type="submit">Comenzar</button></p>
  </form>
  <p class="note">Campaña: ${escapeHtml(campaignName || "—")} · Ejercicio académico autorizado.</p>
</div>`);
}

// ---------------------------------------------------------------------------
// 2) App: tablero + bandeja. `inbox` = [{deliveryId, kind, from, subject, body, isAttack, unread}]
export function renderApp(token, { inbox }) {
  const t = encodeURIComponent(token);
  const unread = inbox.filter((m) => m.unread).length;

  const cols = [
    { title: "Por hacer", cards: [
      { txt: "Preparar el informe semanal", tag: "doc" },
      { txt: "Revisar tarjetas del sprint", tag: "dev" },
      { txt: "Responder mensajes pendientes", tag: "" }] },
    { title: "En progreso", cards: [
      { txt: "Actualizar el tablero del equipo", tag: "dev" },
      { txt: "Agendar la reunión de seguimiento", tag: "ops" }] },
    { title: "Hecho", cards: [{ txt: "Enviar el acta de la reunión anterior", tag: "doc" }] },
  ];

  const board = cols.map((c) => `
    <div class="tf-col" data-col ondragover="event.preventDefault()" ondrop="tfDrop(event)">
      <h3>${c.title}</h3>
      ${c.cards.map((card) => `<div class="tf-card" draggable="true" ondragstart="tfDrag(event)">
        ${escapeHtml(card.txt)}${card.tag ? `<br><span class="tag ${card.tag}">${card.tag === "dev" ? "desarrollo" : card.tag === "doc" ? "documentos" : "operaciones"}</span>` : ""}
      </div>`).join("")}
    </div>`).join("");

  const inboxHtml = inbox.map((m) => `
    <a class="msg ${m.unread ? "unread" : ""}" href="/t/${t}/d/${encodeURIComponent(m.deliveryId)}">
      <div class="row1"><span class="from">${escapeHtml(m.from)}</span><span class="kind">${m.kind === "task" ? "tarea" : "correo"}</span></div>
      <div class="subj">${escapeHtml(m.subject)}</div>
      <div class="prev">${escapeHtml((m.body || "").replace(/<[^>]+>/g, "").slice(0, 80))}</div>
    </a>`).join("");

  return shell("TaskFlow", `
<div class="tf-top">
  <span class="tf-logo">${LOGO_SVG} TaskFlow</span>
  <span class="spacer"></span>
  <button class="tf-chip" onclick="document.getElementById('inbox').scrollIntoView({behavior:'smooth'})">
    ${unread ? '<span class="dot"></span>' : ""} Bandeja${unread ? ` · ${unread}` : ""}
  </button>
  <form method="POST" action="/t/${t}/finish" style="margin:0"
    onsubmit="return confirm('¿Terminar el piloto y pasar a las preguntas finales?')">
    <button class="btn ghost" type="submit">Finalizar piloto</button>
  </form>
</div>
<div class="tf-wrap">
  <div class="tf-board">${board}</div>
  <div class="tf-side" id="inbox">
    <h2>Bandeja de entrada</h2>
    ${inboxHtml || '<p style="padding:1rem;color:var(--muted);font-size:.88rem">No tienes mensajes.</p>'}
  </div>
</div>
<script>
var TF=${JSON.stringify(token)};
function tfPing(){try{navigator.sendBeacon('/t/'+encodeURIComponent(TF)+'/usability')}catch(e){}}
var _d=null;
function tfDrag(e){_d=e.target;e.dataTransfer.effectAllowed='move'}
function tfDrop(e){e.preventDefault();if(_d){e.currentTarget.appendChild(_d);_d=null;tfPing()}}
document.querySelectorAll('.tf-card').forEach(function(c){c.addEventListener('click',tfPing)});
</script>`);
}

// ---------------------------------------------------------------------------
// 2b) Vista de un mensaje (correo o tarea).
export function renderMessage(token, msg) {
  const t = encodeURIComponent(token);
  const isAttack = msg.is_attack;
  const bodyHtml = isAttack ? sanitizeMessageHtml(msg.body) : escapeHtml(msg.body).replace(/\n/g, "<br>");
  const cta = isAttack ? `
    <p style="margin-top:1.5rem;display:flex;gap:.5rem;flex-wrap:wrap">
      <a class="btn" href="/t/${t}/d/${encodeURIComponent(msg.deliveryId)}/go">${escapeHtml(msg.cta_label || "Abrir")}</a>
      <button class="btn subtle" type="button"
        onclick="fetch('/t/${t}/d/${encodeURIComponent(msg.deliveryId)}/report',{method:'POST'}).then(()=>{this.textContent='Reportado ✓';this.disabled=true})">
        Reportar como sospechoso
      </button>
    </p>` : "";

  if (msg.kind === "task") {
    return shell(msg.subject, `
<div class="task-detail">
  <div class="head"><span class="tag">Tarea asignada</span><strong>${escapeHtml(msg.subject)}</strong></div>
  <div class="b">
    <p style="color:var(--muted);font-size:.85rem;margin-top:0">Asignada por ${escapeHtml(msg.from)}</p>
    <div>${bodyHtml}</div>
    ${cta}
  </div>
  <div class="b" style="border-top:1px solid var(--line);padding-top:1rem"><a href="/t/${t}/app">← Volver al tablero</a></div>
</div>`);
  }

  return shell(msg.subject, `
<div class="card-view">
  <p><a href="/t/${t}/app">← Volver a TaskFlow</a></p>
  <div class="meta">De: <strong>${escapeHtml(msg.from)}</strong> &nbsp;·&nbsp; para ti</div>
  <h1>${escapeHtml(msg.subject)}</h1>
  <div class="body">${bodyHtml}</div>
  ${cta}
</div>`);
}

// ---------------------------------------------------------------------------
// 3) Aterrizaje del estímulo.
export function renderStimulusLanding(token, delivery) {
  const t = encodeURIComponent(token);
  const d = encodeURIComponent(delivery.deliveryId);

  if (delivery.landing_kind === "permiso") {
    const cfg = delivery.landing_config || {};
    const scope = cfg.scope || cfg.permiso || "perfil";
    const scopeLabels = {
      perfil: "Ver tu nombre y foto de perfil",
      tareas: "Ver y editar tus tareas y tableros",
      agenda: "Ver los eventos de tu agenda",
      equipo: "Ver la lista de miembros de tu equipo",
      archivos: "Ver los archivos compartidos contigo",
    };
    const label = scopeLabels[scope] || `Acceso solicitado: ${scope}`;
    return shell("TaskFlow — Autorización", `
<div class="perm">
  <div class="head">${LOGO_SVG} Autorizar acceso</div>
  <div class="body">
    <p>${escapeHtml(cfg.titulo || "Una aplicación solicita acceso a tu cuenta de TaskFlow")}.</p>
    <ul class="scopes">
      <li>${CHECK_SVG}<span>${escapeHtml(label)}</span></li>
      ${cfg.detalle ? `<li>${CHECK_SVG}<span>${escapeHtml(cfg.detalle)}</span></li>` : ""}
    </ul>
  </div>
  <div class="actions">
    <button class="btn ghost" onclick="location.href='/t/${t}/app'">Cancelar</button>
    <form method="POST" action="/t/${t}/d/${d}/authorize" style="margin:0">
      <input type="hidden" name="scope" value="${escapeHtml(scope)}">
      <button class="btn" type="submit">Autorizar</button>
    </form>
  </div>
</div>
<p class="note" style="text-align:center">Ejercicio académico · no se accede realmente a ninguna cuenta ni recurso.</p>`);
  }

  // landing_kind === 'form'
  const cfg = delivery.landing_config || {};
  return shell("TaskFlow — Verificación", `
<div class="card-view" style="max-width:420px;margin-top:3rem">
  <div class="tf-logo" style="margin-bottom:1.1rem">${LOGO_SVG} TaskFlow</div>
  <h1>${escapeHtml(cfg.titulo || "Verifica tu identidad")}</h1>
  <p class="meta">${escapeHtml(cfg.detalle || "Vuelve a introducir tus datos de acceso para continuar.")}</p>
  <form id="f" method="POST" action="/t/${t}/d/${d}/submit">
    <div class="field"><label>Usuario o correo</label><input type="text" name="u" autocomplete="off"></div>
    <div class="field"><label>Contraseña</label><input type="password" name="p" autocomplete="off"></div>
    <button class="btn" type="submit" style="width:100%;justify-content:center">Continuar</button>
  </form>
  <p class="note">Al enviar <strong>no se guarda lo que escribas</strong>; solo queda
  registrado que se intentó enviar (ejercicio académico).</p>
</div>
<script>
document.getElementById('f').addEventListener('submit',function(e){
  e.preventDefault();e.target.reset();
  fetch('/t/${t}/d/${d}/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
   .then(function(){location.href='/t/${t}/action-done'});
});
</script>`);
}

// ---------------------------------------------------------------------------
// 4) "Solicitud registrada" — sin revelar todavía.
export function renderActionDone(token) {
  const t = encodeURIComponent(token);
  return shell("TaskFlow", `
<div class="center">
  <h1>Listo</h1>
  <p>Hemos registrado tu solicitud. Puedes seguir usando TaskFlow con normalidad.</p>
  <p style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1.2rem">
    <a class="btn" href="/t/${t}/app">Volver al tablero</a>
    <form method="POST" action="/t/${t}/finish" style="margin:0"
      onsubmit="return confirm('¿Terminar el piloto y pasar a las preguntas finales?')">
      <button class="btn ghost" type="submit">Finalizar piloto</button>
    </form>
  </p>
</div>`);
}

// ---------------------------------------------------------------------------
// 5) Encuesta adaptada al vector.
export function renderSurvey(token, schema) {
  const t = encodeURIComponent(token);
  const vq = schema.vector_question;
  const cq = schema.common;

  const radio = (name, q) => `
    <fieldset>
      <legend>${escapeHtml(q.text)}</legend>
      ${q.options.map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : o.label;
        return `<label class="opt"><input type="radio" name="${name}" value="${escapeHtml(v)}" required> ${escapeHtml(l)}</label>`;
      }).join("")}
    </fieldset>`;

  const select = (name, q, def) => `
    <fieldset>
      <legend>${escapeHtml(q.text)}</legend>
      <div class="field"><select name="${name}">
        ${q.options.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === def ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
      </select></div>
    </fieldset>`;

  return shell("Preguntas finales", `
<div class="center">
  <h1>Unas preguntas para terminar</h1>
  <p>Gracias por probar TaskFlow. Estas preguntas nos ayudan a entender tu experiencia;
  no hay respuestas correctas ni incorrectas.</p>
  <form method="POST" action="/t/${t}/survey">
    ${radio("perceived_suspicion_before_action", cq.perceived_suspicion_before_action)}
    ${radio("vector_specific_answer", vq)}
    ${select("fall_reason", cq.fall_reason, schema.default_reason)}
    ${radio("recognized_as_simulated", cq.recognized_as_simulated)}
    <fieldset>
      <legend>¿Quieres añadir algo? (opcional)</legend>
      <div class="field"><textarea name="free_comment" rows="3" maxlength="1000" placeholder="Comentario libre..."></textarea></div>
    </fieldset>
    <button class="btn" type="submit">Enviar respuestas</button>
  </form>
</div>`);
}

// ---------------------------------------------------------------------------
// 6) Debriefing.
export function renderDebrief(html) {
  return shell("Información sobre el estudio", `
<div class="debrief">
  <h1>Información sobre el estudio</h1>
  <p>${html.replace(/\n\n/g, "</p><p>")}</p>
  <p style="margin-top:1.5rem;color:var(--muted);font-size:.9rem">Ya puedes cerrar esta pestaña. Gracias por tu participación.</p>
</div>`);
}

export function renderInvalid(msg) {
  return shell("Enlace no válido", `
<div class="center"><h1>Enlace no válido</h1>
<p>${escapeHtml(msg || "Este enlace no es válido o ya ha caducado.")}</p></div>`);
}
