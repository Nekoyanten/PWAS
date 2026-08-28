// Renderizado de la app señuelo "TaskFlow" y de las pantallas del flujo del
// participante. Marca deliberadamente GENÉRICA y FICTICIA (PS §3.2: prohibido
// suplantar una identidad/servicio real concreto).
//
// Todo el estado del participante viaja en el token de la URL: no hay cookies
// ni sesión de servidor. Ninguna de estas pantallas captura contenido escrito
// por el participante (ver nota de cumplimiento en schema.sql).

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Se permite HTML simple en el cuerpo del mensaje de la plantilla, pero se
// sanea a una lista blanca mínima para no abrir un XSS con contenido de admin.
function sanitizeMessageHtml(html) {
  if (!html) return "";
  let out = escapeHtml(html);
  out = out
    .replace(/&lt;(\/?(?:b|strong|i|em|u|p|br|ul|ol|li|span))&gt;/gi, "<$1>")
    .replace(/\n/g, "<br>");
  return out;
}

function shell(title, bodyHtml, extraHead = "") {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>${extraHead}</head><body>${bodyHtml}</body></html>`;
}

const BASE_CSS = `
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;background:#f1f3f7;color:#1c2434}
a{color:#2f6bd8}
.tf-top{background:#1b3a6b;color:#fff;display:flex;align-items:center;gap:1rem;padding:.6rem 1rem}
.tf-logo{font-weight:800;letter-spacing:.3px;font-size:1.05rem;display:flex;align-items:center;gap:.4rem}
.tf-logo .dot{width:10px;height:10px;border-radius:3px;background:#4fd1c5;display:inline-block}
.tf-top .spacer{flex:1}
.tf-bell{position:relative;background:rgba(255,255,255,.14);border:none;color:#fff;border-radius:8px;padding:.4rem .7rem;cursor:pointer;font-size:.9rem}
.tf-bell .badge{position:absolute;top:-6px;right:-6px;background:#e5484d;color:#fff;border-radius:10px;font-size:.7rem;padding:0 5px;line-height:1.4}
.tf-wrap{display:flex;gap:1rem;padding:1rem;max-width:1200px;margin:0 auto;align-items:flex-start}
.tf-board{flex:1;display:flex;gap:1rem;overflow-x:auto;padding-bottom:.5rem}
.tf-col{background:#e9edf4;border-radius:12px;padding:.7rem;min-width:250px;flex:1}
.tf-col h3{margin:.2rem .3rem .6rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.5px;color:#5a6b85}
.tf-card{background:#fff;border-radius:9px;padding:.65rem .75rem;margin-bottom:.55rem;box-shadow:0 1px 4px rgba(20,40,80,.09);font-size:.92rem;cursor:grab}
.tf-card:active{cursor:grabbing}
.tf-card .tag{display:inline-block;font-size:.72rem;padding:.05rem .45rem;border-radius:20px;margin-top:.4rem}
.tag.dev{background:#e0ecff;color:#2456b8}.tag.doc{background:#e6f7ec;color:#1c8a4b}.tag.urg{background:#fdecec;color:#c0392b}
.tf-side{width:340px;flex-shrink:0;background:#fff;border-radius:12px;box-shadow:0 1px 6px rgba(20,40,80,.09);overflow:hidden}
.tf-side h2{margin:0;padding:.8rem 1rem;font-size:.95rem;background:#f7f9fc;border-bottom:1px solid #e6eaf1}
.msg{padding:.75rem 1rem;border-bottom:1px solid #eef1f6;cursor:pointer}
.msg:hover{background:#f7f9fc}
.msg .from{font-weight:600;font-size:.9rem}
.msg .subj{font-size:.88rem;color:#33415c}
.msg .prev{font-size:.8rem;color:#8592a8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msg.unread .from::before{content:"●";color:#2f6bd8;font-size:.7rem;margin-right:.35rem;vertical-align:middle}
.card-view{max-width:640px;margin:2.5rem auto;background:#fff;border-radius:14px;box-shadow:0 6px 30px rgba(20,40,80,.12);padding:1.6rem 1.8rem}
.card-view h1{font-size:1.2rem;margin:.2rem 0 .3rem;color:#1b3a6b}
.card-view .meta{font-size:.82rem;color:#8592a8;margin-bottom:1rem}
.btn{display:inline-block;background:#2f6bd8;color:#fff;border:none;border-radius:8px;padding:.6rem 1.15rem;font-size:.95rem;cursor:pointer;text-decoration:none}
.btn:hover{background:#2559b8}
.btn.ghost{background:#eef1f6;color:#33415c}
.btn.warn{background:#e5484d}
.field{display:block;margin:.7rem 0}
.field label{display:block;font-size:.85rem;margin-bottom:.25rem;color:#41506b}
.field input,.field select,.field textarea{width:100%;padding:.55rem .6rem;border:1px solid #cbd3e1;border-radius:7px;font-size:.95rem;font-family:inherit}
.perm-dialog{max-width:420px;margin:3.5rem auto;background:#fff;border-radius:14px;box-shadow:0 10px 40px rgba(20,40,80,.18);overflow:hidden}
.perm-dialog .head{display:flex;gap:.6rem;align-items:center;padding:1rem 1.2rem;border-bottom:1px solid #eef1f6}
.perm-dialog .body{padding:1.1rem 1.2rem;font-size:.92rem;color:#33415c}
.perm-dialog .actions{display:flex;gap:.5rem;justify-content:flex-end;padding:.9rem 1.2rem;background:#f7f9fc}
.note{font-size:.8rem;color:#8592a8;margin-top:1.2rem}
.center{max-width:560px;margin:3rem auto;background:#fff;border-radius:14px;box-shadow:0 6px 30px rgba(20,40,80,.1);padding:1.8rem 2rem}
.center h1{color:#1b3a6b;font-size:1.35rem;margin-top:0}
fieldset{border:1px solid #e0e5ef;border-radius:10px;margin:1rem 0;padding:.8rem 1rem}
fieldset legend{font-size:.9rem;font-weight:600;color:#41506b;padding:0 .4rem}
.opt{display:block;margin:.35rem 0;font-size:.92rem}
.debrief{max-width:680px;margin:3rem auto;background:#fff;border-radius:14px;box-shadow:0 6px 30px rgba(20,40,80,.1);padding:1.8rem 2rem;line-height:1.6}
.debrief h1{color:#1b3a6b}
`;

// ---------------------------------------------------------------------------
// 1) Bienvenida + consentimiento (tapadera: "piloto de usabilidad").
export function renderWelcome(token, campaignName) {
  return shell("TaskFlow — Piloto de usabilidad", `
<div class="center">
  <div class="tf-logo" style="color:#1b3a6b;margin-bottom:1rem"><span class="dot"></span> TaskFlow</div>
  <h1>Piloto de usabilidad</h1>
  <p>Gracias por participar en la evaluación de <strong>TaskFlow</strong>, un organizador
  de tareas en el que estamos trabajando. Te pediremos que uses la aplicación con
  normalidad durante unos minutos: revisar tus tarjetas, tu bandeja de mensajes y
  organizar tu trabajo como lo harías cualquier día.</p>
  <p>La sesión es <strong>anónima</strong>. No se registra tu nombre ni el contenido de
  lo que escribas: solo cómo interactúas con la interfaz. Al final te haremos unas
  preguntas breves.</p>
  <form method="POST" action="/t/${encodeURIComponent(token)}/consent">
    <label class="opt"><input type="checkbox" name="consent" value="1" required>
      He leído lo anterior y acepto participar en el piloto.</label>
    <p><button class="btn" type="submit">Comenzar</button></p>
  </form>
  <p class="note">Campaña: ${escapeHtml(campaignName || "—")} · Ejercicio académico autorizado.</p>
</div>`);
}

// ---------------------------------------------------------------------------
// 2) App señuelo: tablero kanban + bandeja de mensajes.
//    `messages` = [{id, from, subject, body, kind: 'info'|'stimulus', unread}]
export function renderApp(token, { campaignName, messages, finished }) {
  const t = encodeURIComponent(token);
  const unreadCount = messages.filter((m) => m.unread).length;

  const cols = [
    { title: "Por hacer", cards: [
      { txt: "Preparar informe semanal", tag: "doc" },
      { txt: "Revisar tarjetas del sprint", tag: "dev" },
      { txt: "Responder correos pendientes", tag: "" },
    ]},
    { title: "En progreso", cards: [
      { txt: "Actualizar el tablero del equipo", tag: "dev" },
      { txt: "Agendar reunión de seguimiento", tag: "" },
    ]},
    { title: "Hecho", cards: [
      { txt: "Enviar acta de la reunión anterior", tag: "doc" },
    ]},
  ];

  const boardHtml = cols.map((c) => `
    <div class="tf-col" data-col ondragover="event.preventDefault()" ondrop="tfDrop(event)">
      <h3>${c.title}</h3>
      ${c.cards.map((card) => `<div class="tf-card" draggable="true" ondragstart="tfDrag(event)">
        ${escapeHtml(card.txt)}${card.tag ? `<br><span class="tag ${card.tag}">${card.tag === "dev" ? "desarrollo" : card.tag === "doc" ? "documentos" : ""}</span>` : ""}
      </div>`).join("")}
    </div>`).join("");

  const inboxHtml = messages.map((m) => `
    <a class="msg ${m.unread ? "unread" : ""}" href="/t/${t}/message/${encodeURIComponent(m.id)}">
      <div class="from">${escapeHtml(m.from)}</div>
      <div class="subj">${escapeHtml(m.subject)}</div>
      <div class="prev">${escapeHtml((m.body || "").replace(/<[^>]+>/g, "").slice(0, 70))}</div>
    </a>`).join("");

  return shell("TaskFlow", `
<div class="tf-top">
  <span class="tf-logo"><span class="dot"></span> TaskFlow</span>
  <span class="spacer"></span>
  <button class="tf-bell" onclick="document.getElementById('inbox').scrollIntoView({behavior:'smooth'})">
    Bandeja ${unreadCount ? `<span class="badge">${unreadCount}</span>` : ""}
  </button>
  <form method="POST" action="/t/${t}/finish" style="margin:0"
    onsubmit="return confirm('¿Terminar el piloto y pasar a las preguntas finales?')">
    <button class="btn ghost" type="submit">Finalizar piloto</button>
  </form>
</div>
<div class="tf-wrap">
  <div class="tf-board">${boardHtml}</div>
  <div class="tf-side" id="inbox">
    <h2>Bandeja de mensajes</h2>
    ${inboxHtml || '<p style="padding:1rem;color:#8592a8">Sin mensajes.</p>'}
  </div>
</div>
<script>
var TF_TOKEN=${JSON.stringify(token)};
function tfPing(){navigator.sendBeacon('/t/'+encodeURIComponent(TF_TOKEN)+'/usability');}
var _drag=null;
function tfDrag(e){_drag=e.target;e.dataTransfer.effectAllowed='move';}
function tfDrop(e){e.preventDefault();if(_drag){e.currentTarget.appendChild(_drag);_drag=null;tfPing();}}
document.querySelectorAll('.tf-card').forEach(function(c){c.addEventListener('click',tfPing);});
</script>`);
}

// ---------------------------------------------------------------------------
// 2b) Vista de un mensaje de la bandeja.
export function renderMessage(token, message) {
  const t = encodeURIComponent(token);
  const isStimulus = message.kind === "stimulus";
  const bodyHtml = isStimulus ? sanitizeMessageHtml(message.body) : escapeHtml(message.body).replace(/\n/g, "<br>");
  return shell(message.subject, `
<div class="card-view">
  <p><a href="/t/${t}/app">&larr; Volver a TaskFlow</a></p>
  <div class="meta">De: <strong>${escapeHtml(message.from)}</strong></div>
  <h1>${escapeHtml(message.subject)}</h1>
  <div>${bodyHtml}</div>
  ${isStimulus
    ? `<p style="margin-top:1.4rem">
         <a class="btn" href="/t/${t}/stimulus">${escapeHtml(message.cta_label || "Abrir")}</a>
         <button class="btn ghost" style="margin-left:.4rem"
           onclick="fetch('/t/${t}/report',{method:'POST'}).then(()=>{this.textContent='Reportado ✓';this.disabled=true})">
           Reportar como sospechoso
         </button>
       </p>`
    : ""}
</div>`);
}

// ---------------------------------------------------------------------------
// 3) Aterrizaje del estímulo — depende de landing_kind.
export function renderStimulusLanding(token, template) {
  const t = encodeURIComponent(token);
  if (template.landing_kind === "permiso") {
    const cfg = template.landing_config || {};
    const permiso = cfg.permiso || "camara";
    const nombrePermiso = { camara: "la cámara", microfono: "el micrófono", calendario: "el calendario", contactos: "los contactos", ubicacion: "la ubicación" }[permiso] || permiso;
    return shell("TaskFlow — Permiso requerido", `
<div class="perm-dialog">
  <div class="head"><span class="tf-logo" style="color:#1b3a6b"><span class="dot"></span> TaskFlow</span></div>
  <div class="body">
    <p><strong>${escapeHtml(cfg.titulo || `TaskFlow quiere acceder a ${nombrePermiso}`)}</strong></p>
    <p>${escapeHtml(cfg.detalle || `Para continuar con esta acción, la aplicación necesita permiso para usar ${nombrePermiso}.`)}</p>
  </div>
  <div class="actions">
    <button class="btn ghost" onclick="location.href='/t/${t}/app'">Ahora no</button>
    <form method="POST" action="/t/${t}/grant" style="margin:0">
      <input type="hidden" name="permiso" value="${escapeHtml(permiso)}">
      <button class="btn" type="submit">Permitir</button>
    </form>
  </div>
</div>
<p class="note" style="text-align:center">Ejercicio académico · no se accede realmente a ningún recurso.</p>`);
  }

  // landing_kind === 'form'
  const cfg = template.landing_config || {};
  return shell("TaskFlow — Verificación", `
<div class="card-view" style="max-width:420px">
  <div class="tf-logo" style="color:#1b3a6b;margin-bottom:1rem"><span class="dot"></span> TaskFlow</div>
  <h1>${escapeHtml(cfg.titulo || "Verifica tu identidad")}</h1>
  <p class="meta">${escapeHtml(cfg.detalle || "Vuelve a introducir tus datos de acceso para continuar.")}</p>
  <form id="f" method="POST" action="/t/${t}/submit">
    <div class="field"><label>Usuario</label><input type="text" name="u" autocomplete="off"></div>
    <div class="field"><label>Contraseña</label><input type="password" name="p" autocomplete="off"></div>
    <button class="btn" type="submit">Continuar</button>
  </form>
  <p class="note">Al enviar este formulario <strong>no se guarda lo que escribas</strong>;
  solo queda registrado que se intentó enviar (ejercicio académico).</p>
</div>
<script>
document.getElementById('f').addEventListener('submit',function(e){
  e.preventDefault();e.target.reset();
  fetch('/t/${t}/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
   .then(function(r){location.href='/t/${t}/action-done';});
});
</script>`);
}

// ---------------------------------------------------------------------------
// 4) "Solicitud registrada" — pantalla neutra, SIN revelar todavía.
export function renderActionDone(token) {
  const t = encodeURIComponent(token);
  return shell("TaskFlow", `
<div class="center">
  <h1>Solicitud registrada</h1>
  <p>Hemos registrado tu solicitud. Puedes seguir usando TaskFlow con normalidad.</p>
  <p>
    <a class="btn" href="/t/${t}/app">Volver al tablero</a>
    <form method="POST" action="/t/${t}/finish" style="display:inline;margin-left:.4rem"
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

  const radioBlock = (name, q) => `
    <fieldset>
      <legend>${escapeHtml(q.text)}</legend>
      ${q.options.map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : o.label;
        return `<label class="opt"><input type="radio" name="${name}" value="${escapeHtml(v)}" required> ${escapeHtml(l)}</label>`;
      }).join("")}
    </fieldset>`;

  const selectBlock = (name, q, def) => `
    <fieldset>
      <legend>${escapeHtml(q.text)}</legend>
      <div class="field"><select name="${name}">
        ${q.options.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === def ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
      </select></div>
    </fieldset>`;

  return shell("Preguntas finales", `
<div class="center">
  <h1>Unas preguntas para terminar</h1>
  <p>Gracias por probar TaskFlow. Estas preguntas nos ayudan a entender tu experiencia.
  No hay respuestas correctas ni incorrectas.</p>
  <form method="POST" action="/t/${t}/survey">
    ${radioBlock("perceived_suspicion_before_action", cq.perceived_suspicion_before_action)}
    ${radioBlock("vector_specific_answer", vq)}
    ${selectBlock("fall_reason", cq.fall_reason, schema.default_reason)}
    ${radioBlock("recognized_as_simulated", cq.recognized_as_simulated)}
    <fieldset>
      <legend>¿Quieres añadir algo? (opcional)</legend>
      <div class="field"><textarea name="free_comment" rows="3" maxlength="1000"
        placeholder="Comentario libre..."></textarea></div>
    </fieldset>
    <button class="btn" type="submit">Enviar respuestas</button>
  </form>
</div>`);
}

// ---------------------------------------------------------------------------
// 6) Debriefing — la revelación, tras enviar la encuesta.
export function renderDebrief(html) {
  return shell("Información sobre el estudio", `
<div class="debrief">
  <h1>Información sobre el estudio</h1>
  <p>${html.replace(/\n\n/g, "</p><p>")}</p>
  <p style="margin-top:1.5rem;color:#8592a8;font-size:.9rem">
    Ya puedes cerrar esta pestaña. Gracias por tu participación.</p>
</div>`);
}

export function renderInvalid(msg) {
  return shell("Enlace no válido", `
<div class="center"><h1>Enlace no válido</h1>
<p>${escapeHtml(msg || "Este enlace no es válido o ya ha caducado.")}</p></div>`);
}
