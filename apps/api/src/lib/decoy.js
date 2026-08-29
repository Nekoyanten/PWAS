// Renderizado de la app señuelo "TaskFlow" y de las pantallas del flujo del
// participante. Marca GENÉRICA y FICTICIA (PS §3.2). Todo el estado viaja en
// el token de la URL. Ninguna pantalla captura contenido escrito por el
// participante.

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function sanitizeMessageHtml(html) {
  if (!html) return "";
  return escapeHtml(html)
    .replace(/&lt;(\/?(?:b|strong|i|em|u|p|br|ul|ol|li|span|h3|h4)(?:\s[^&]*?)?)&gt;/gi, "<$1>")
    .replace(/\n/g, "<br>");
}

function shell(title, bodyHtml, opts = {}) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600;700&display=swap" rel="stylesheet">
${opts.head || ""}
<style>${BASE_CSS}${opts.extraCss || ""}</style></head><body class="${opts.bodyClass || ""}">${bodyHtml}</body></html>`;
}

const BASE_CSS = `
:root{
  --bg:#f5f6f8; --panel:#fbfbfc; --surface:#ffffff; --line:#e7e8ec; --line-soft:#eef0f3;
  --ink:#1a1d24; --ink-2:#3b4048; --muted:#6a7180; --faint:#9aa1ad;
  --brand:#4f46e5; --brand-strong:#4338ca; --brand-tint:#eef0fe;
  --ok:#0f9d7a; --warn:#d64545;
  --radius:12px; --radius-sm:9px;
  --shadow-sm:0 1px 2px rgba(19,24,38,.06);
  --shadow:0 1px 2px rgba(19,24,38,.05),0 6px 20px rgba(19,24,38,.07);
  --shadow-lg:0 12px 44px rgba(19,24,38,.16);
}
*{box-sizing:border-box}
html,body{height:100%}
body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;font-size:14px;line-height:1.5}
a{color:var(--brand);text-decoration:none}
a:hover{color:var(--brand-strong)}
h1,h2,h3{letter-spacing:-.012em}
button{font:inherit}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;background:var(--brand);color:#fff;border:1px solid var(--brand);border-radius:var(--radius-sm);padding:.6rem 1.05rem;font-weight:600;font-size:.9rem;cursor:pointer;transition:background .12s}
.btn:hover{background:var(--brand-strong);border-color:var(--brand-strong)}
.btn.ghost{background:#fff;color:var(--ink-2);border-color:var(--line)}
.btn.ghost:hover{background:var(--line-soft)}
.btn.subtle{background:transparent;border-color:transparent;color:var(--muted);font-weight:500}
.btn.subtle:hover{background:var(--line-soft);color:var(--ink-2)}
.btn.block{width:100%}

.icn{width:18px;height:18px;flex:none}
.avatar{width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:.68rem;font-weight:600;color:#fff;flex:none}

/* ---------- app shell ---------- */
.app{display:grid;grid-template-columns:224px 1fr;height:100vh;overflow:hidden}
.rail{background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:.9rem .7rem;gap:.15rem}
.rail .brand{display:flex;align-items:center;gap:.55rem;font-weight:700;font-size:.98rem;padding:.35rem .5rem .9rem}
.rail .brand svg{width:22px;height:22px}
.rail a,.rail .navitem{display:flex;align-items:center;gap:.6rem;padding:.5rem .55rem;border-radius:8px;color:var(--ink-2);font-weight:500;font-size:.875rem;width:100%;background:none;border:0;font-family:inherit;text-align:left;cursor:pointer}
.rail a:hover,.rail .navitem:hover{background:var(--line-soft)}
.rail a.active,.rail .navitem.active{background:var(--brand-tint);color:var(--brand-strong)}
.rail a.active svg,.rail .navitem.active svg{color:var(--brand)}
.rail .navitem>span{flex:1}
.rail-badge{background:var(--brand);color:#fff;border-radius:20px;font-size:.7rem;font-weight:700;padding:.02rem .42rem;min-width:1.1rem;text-align:center;flex:none}
.rail svg{width:17px;height:17px;color:var(--muted);flex:none}
.rail .spring{flex:1}
.rail .u{display:flex;align-items:center;gap:.55rem;padding:.5rem .55rem;font-size:.83rem;color:var(--muted)}

.main{overflow-y:auto;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:4;background:rgba(245,246,248,.82);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:.85rem 1.4rem;display:flex;align-items:center;gap:1rem}
.topbar h1{font-size:1.02rem;margin:0;font-weight:650}
.topbar .crumb{color:var(--faint);font-weight:500}
.topbar .spring{flex:1}
.content{padding:1.4rem;flex:1}

/* ---------- board ---------- */
.workspace{display:flex;gap:1.15rem;align-items:flex-start}
.board-area{flex:1;min-width:0}
.board-head{display:flex;align-items:center;gap:.7rem;margin:0 0 1.15rem}
.board-head h2{font-size:1.18rem;margin:0}
.pill{font-size:.72rem;font-weight:600;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:.15rem .6rem}
.columns{display:flex;gap:1rem;align-items:flex-start;overflow-x:auto;padding-bottom:.6rem}
.ib-badge{margin-left:auto;background:var(--brand);color:#fff;border-radius:20px;font-size:.72rem;font-weight:600;padding:.05rem .5rem}
.col{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:.75rem;width:270px;flex:none}
.col-head{display:flex;align-items:center;justify-content:space-between;margin:.1rem .25rem .7rem}
.col-head .t{font-size:.78rem;font-weight:650;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.col-head .n{font-size:.72rem;color:var(--faint);background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:0 .4rem}
.tcard{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:.7rem .78rem;margin-bottom:.6rem;box-shadow:var(--shadow-sm);cursor:grab}
.tcard:hover{border-color:#d9dbe1}
.tcard:active{cursor:grabbing}
.tcard .tt{font-weight:500;font-size:.9rem;line-height:1.4}
.tcard .labels{display:flex;gap:.35rem;flex-wrap:wrap;margin-top:.5rem}
.lab{font-size:.68rem;font-weight:600;padding:.12rem .48rem;border-radius:6px}
.lab.dev{background:#ecebfe;color:#4338ca}.lab.doc{background:#e2f5ec;color:#0f7a5f}.lab.ops{background:#fdeede;color:#a25b18}.lab.due{background:#fdeaea;color:#c0392f}
.tcard .foot{display:flex;align-items:center;justify-content:space-between;margin-top:.6rem}
.tcard .meta{display:flex;align-items:center;gap:.35rem;font-size:.74rem;color:var(--muted)}

/* ---------- inbox drawer ---------- */
.inbox{width:340px;flex:none;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;align-self:flex-start;position:sticky;top:76px}
.inbox h3{margin:0;padding:.9rem 1.05rem;font-size:.9rem;font-weight:650;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:.45rem}
.inbox h3 svg{width:17px;height:17px;color:var(--muted);flex:none}
.mrow{display:flex;gap:.7rem;padding:.85rem 1.05rem;border-bottom:1px solid var(--line-soft);cursor:pointer}
.mrow:last-child{border-bottom:0}
.mrow:hover{background:var(--panel)}
.mrow .ic{width:32px;height:32px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--brand-tint);color:var(--brand)}
.mrow .ic svg{width:16px;height:16px}
.mrow .bd{min-width:0;flex:1}
.mrow .l1{display:flex;justify-content:space-between;gap:.5rem;align-items:baseline}
.mrow .from{font-weight:600;font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mrow .tag{font-size:.64rem;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);border:1px solid var(--line);border-radius:5px;padding:0 .3rem;flex:none}
.mrow .sj{font-size:.84rem;color:var(--ink-2);margin-top:.1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mrow .pv{font-size:.78rem;color:var(--faint);margin-top:.1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mrow.unread .from::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--brand);margin-right:.4rem;vertical-align:middle}
.inbox .empty{padding:1.3rem 1.05rem;color:var(--faint);font-size:.85rem}

/* ---------- reading pane ---------- */
.reader{max-width:760px;margin:0 auto}
.reader .back{display:inline-flex;align-items:center;gap:.35rem;color:var(--muted);font-size:.85rem;font-weight:500;margin-bottom:1rem}
.reader .back svg{width:16px;height:16px}
.reader .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}
.reader .hd{padding:1.15rem 1.5rem;border-bottom:1px solid var(--line-soft)}
.reader .hd .kind{font-size:.7rem;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--brand)}
.reader .hd h1{font-size:1.28rem;margin:.35rem 0 .55rem}
.reader .hd .who{display:flex;align-items:center;gap:.55rem;color:var(--muted);font-size:.82rem}
.reader .bd{padding:1.35rem 1.5rem;font-size:.95rem;line-height:1.65;color:var(--ink-2)}
.reader .bd p{margin:.2rem 0 .9rem}
.reader .actions{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;padding:0 1.5rem 1.45rem}

/* ---------- centered pages ---------- */
.plate{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem 1.25rem}
.sheet{width:100%;max-width:440px;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:2rem}
.sheet.wide{max-width:560px}
.sheet .brand{display:flex;align-items:center;gap:.55rem;font-weight:700;font-size:1rem;margin-bottom:1.35rem}
.sheet .brand svg{width:24px;height:24px}
.sheet h1{font-size:1.32rem;margin:.1rem 0 .55rem}
.sheet p{color:var(--ink-2);margin:.4rem 0}
.sheet .sub{color:var(--muted);font-size:.9rem;margin-bottom:1.2rem}
.field{margin:.85rem 0}
.field label{display:block;font-size:.82rem;font-weight:550;color:var(--ink-2);margin-bottom:.32rem}
.field input,.field select,.field textarea{width:100%;padding:.62rem .7rem;border:1px solid var(--line);border-radius:var(--radius-sm);font:inherit;font-size:.92rem;background:#fff}
.field input:focus,.field select:focus,.field textarea:focus{outline:2px solid var(--brand-tint);border-color:var(--brand)}
.note{font-size:.8rem;color:var(--faint);margin-top:1.15rem;line-height:1.5}
.check{display:flex;gap:.6rem;align-items:flex-start;font-size:.9rem;color:var(--ink-2);margin:1rem 0}
.check input{margin-top:.2rem}

/* survey */
.survey fieldset{border:1px solid var(--line);border-radius:11px;margin:1rem 0;padding:.95rem 1.1rem}
.survey legend{font-size:.88rem;font-weight:600;color:var(--ink);padding:0 .35rem}
.survey .opt{display:flex;gap:.55rem;align-items:center;margin:.45rem 0;font-size:.9rem;color:var(--ink-2)}

/* authorize dialog */
.authwrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem 1.25rem;background:linear-gradient(180deg,#eef0f6,#f5f6f8)}
.authcard{width:100%;max-width:412px;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow-lg);overflow:hidden}
.authcard .hd{padding:1.3rem 1.4rem 1rem;text-align:center;border-bottom:1px solid var(--line-soft)}
.authcard .hd .logos{display:flex;align-items:center;justify-content:center;gap:.7rem;margin-bottom:.7rem}
.authcard .hd .logos svg{width:26px;height:26px}
.authcard .hd h1{font-size:1.05rem;margin:.2rem 0 0}
.authcard .bd{padding:1.15rem 1.4rem}
.authcard .scopes{list-style:none;margin:.4rem 0 0;padding:0}
.authcard .scopes li{display:flex;gap:.6rem;align-items:flex-start;padding:.5rem 0;font-size:.9rem;color:var(--ink-2)}
.authcard .scopes svg{width:17px;height:17px;color:var(--ok);flex:none;margin-top:.12rem}
.authcard .ft{display:flex;gap:.6rem;padding:1.1rem 1.4rem;background:var(--panel);border-top:1px solid var(--line-soft)}
.authcard .ft .btn{flex:1}

.debrief{max-width:660px;margin:3rem auto;padding:0 1.25rem;line-height:1.7}
.debrief .card{background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:2rem 2.15rem}
.debrief h1{font-size:1.4rem;margin:.1rem 0 .8rem}
.debrief p{color:var(--ink-2);margin:.6rem 0}
.debrief .brand svg{width:22px;height:22px}
.donemark{width:52px;height:52px;border-radius:50%;background:var(--brand-tint);color:var(--brand);display:flex;align-items:center;justify-content:center;margin:0 auto 1rem}
.donemark svg{width:26px;height:26px}

@media(max-width:1400px){
  .workspace{flex-direction:column}
  .inbox{width:100%;position:static}
}
@media(max-width:960px){
  .app{grid-template-columns:1fr}
  .rail{display:none}
}
`;

const LOGO = `<svg viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#4f46e5"/><path d="M6.5 12.5 10 16l7.5-8" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const I = {
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>`,
  board: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/></svg>`,
  inbox: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h5l2 3h4l2-3h5"/><path d="M5 5h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/></svg>`,
  cal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
  team: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.5a3 3 0 0 1 0 5.8M15.5 20a5.5 5.5 0 0 0-2-4.3"/></svg>`,
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg>`,
  task: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
};
const AV_COLORS = ["#4f46e5", "#0f9d7a", "#d97706", "#db2777", "#0284c7"];
const avatar = (name) => {
  const s = String(name || "?");
  const init = s.split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase() || "?";
  let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="avatar" style="background:${AV_COLORS[h % AV_COLORS.length]}">${escapeHtml(init)}</span>`;
};

// Las 5 vistas de la app señuelo. En renderApp se conmutan en cliente (sin
// recarga); en las páginas sueltas (renderMessage) el rail es un enlace normal
// que vuelve a /app?v=<vista>.
const VIEWS = [
  { key: "inicio", icon: I.home, label: "Inicio", title: "Inicio" },
  { key: "tablero", icon: I.board, label: "Mi tablero", title: "Mi tablero" },
  { key: "bandeja", icon: I.inbox, label: "Bandeja", title: "Bandeja" },
  { key: "agenda", icon: I.cal, label: "Agenda", title: "Agenda" },
  { key: "equipo", icon: I.team, label: "Equipo", title: "Equipo" },
];
const DEFAULT_VIEW = "tablero";
const viewTitle = (key) => (VIEWS.find((v) => v.key === key) || VIEWS[1]).title;
const isView = (key) => VIEWS.some((v) => v.key === key);

function rail(active, token, spa) {
  const t = encodeURIComponent(token || "");
  const items = VIEWS.map((v) => {
    const cls = `navitem${active === v.key ? " active" : ""}`;
    const badge = v.key === "bandeja" ? `<span class="rail-badge" data-ibbadge hidden></span>` : "";
    return spa
      ? `<button type="button" class="${cls}" data-view="${v.key}">${v.icon}<span>${v.label}</span>${badge}</button>`
      : `<a class="${cls}" href="/t/${t}/app?v=${v.key}">${v.icon}<span>${v.label}</span>${badge}</a>`;
  }).join("");
  return `<nav class="rail">
    <div class="brand">${LOGO}<span>TaskFlow</span></div>
    ${items}
    <div class="spring"></div>
    <div class="u">${avatar("Tú")}<span>Sesión del piloto</span></div>
  </nav>`;
}

function inboxRowsHtml(inbox, t) {
  return inbox.map((m) => `
    <a class="mrow msg ${m.unread ? "unread" : ""}" href="/t/${t}/d/${encodeURIComponent(m.deliveryId)}">
      <span class="ic">${m.kind === "task" ? I.task : I.mail}</span>
      <span class="bd">
        <span class="l1"><span class="from">${escapeHtml(m.from)}</span><span class="tag">${m.kind === "task" ? "tarea" : "correo"}</span></span>
        <span class="sj">${escapeHtml(m.subject)}</span>
        <span class="pv">${escapeHtml((m.body || "").replace(/<[^>]+>/g, "").slice(0, 90))}</span>
      </span>
    </a>`).join("");
}

// ---------------------------------------------------------------------------
export function renderWelcome(token, campaignName) {
  return shell("TaskFlow — Piloto de usabilidad", `
<div class="plate">
  <div class="sheet">
    <div class="brand">${LOGO} TaskFlow</div>
    <h1>Piloto de usabilidad</h1>
    <p class="sub">Unos minutos usando TaskFlow con normalidad.</p>
    <p>Gracias por ayudarnos a evaluar <strong>TaskFlow</strong>, un organizador de tareas en
    desarrollo. Te pediremos revisar tus tarjetas y tu bandeja de mensajes, y organizar tu
    trabajo como cualquier día.</p>
    <p>La sesión es <strong>anónima</strong>: no se registra tu nombre ni el contenido de lo
    que escribas, solo cómo interactúas con la interfaz. Al terminar te haremos unas
    preguntas breves.</p>
    <form method="POST" action="/t/${encodeURIComponent(token)}/consent">
      <label class="check"><input type="checkbox" name="consent" value="1" required>
        <span>He leído lo anterior y acepto participar en el piloto.</span></label>
      <button class="btn block" type="submit">Comenzar</button>
    </form>
    <p class="note">Campaña: ${escapeHtml(campaignName || "—")} · Ejercicio académico autorizado.</p>
  </div>
</div>`);
}

export function renderApp(token, { inbox, view }) {
  const t = encodeURIComponent(token);
  const unread = inbox.filter((m) => m.unread).length;
  const active = isView(view) ? view : DEFAULT_VIEW;

  // Tablero inicial. A partir de aquí lo gestiona Alpine.js en el navegador del
  // participante y se guarda SOLO en su localStorage (nunca llega al servidor:
  // ver nota de privacidad de schema.sql). El admin no ve estas tarjetas.
  const defaultBoard = [
    { id: "todo", title: "Por hacer", cards: [
      { id: "s1", title: "Preparar el informe semanal del proyecto", who: "María L.", due: "Hoy", overdue: true, labels: [{ cls: "doc", text: "documentos" }] },
      { id: "s2", title: "Revisar las tarjetas pendientes del sprint", who: "Tú", due: "Mié", labels: [{ cls: "dev", text: "desarrollo" }] },
      { id: "s3", title: "Responder los mensajes del canal del equipo", who: "Tú", labels: [] } ] },
    { id: "doing", title: "En progreso", cards: [
      { id: "s4", title: "Actualizar el tablero de seguimiento", who: "Tú", due: "Jue", labels: [{ cls: "dev", text: "desarrollo" }] },
      { id: "s5", title: "Agendar la reunión de seguimiento mensual", who: "Carlos R.", labels: [{ cls: "ops", text: "operaciones" }] } ] },
    { id: "done", title: "Hecho", cards: [
      { id: "s6", title: "Enviar el acta de la reunión anterior", who: "Tú", labels: [{ cls: "doc", text: "documentos" }] } ] },
  ];

  const rows = inboxRowsHtml(inbox, t);
  const emptyInbox = '<div class="empty">No tienes mensajes.</div>';

  const team = [
    ["María L.", "Coordinación"], ["Carlos R.", "Operaciones"],
    ["Ana P.", "Desarrollo"], ["Diego S.", "Documentación"], ["Tú", "Participante del piloto"],
  ];
  const week = [
    ["Lun", ["10:00 · Reunión de equipo"]], ["Mar", []],
    ["Mié", ["15:30 · Revisión del sprint"]], ["Jue", []],
    ["Vie", ["10:00 · Seguimiento semanal", "16:00 · Cierre de tareas"]],
  ];

  const panel = (key, html) => `<section class="view${active === key ? " active" : ""}" data-view-panel="${key}">${html}</section>`;

  const viewInicio = `
    <div class="home-view">
      <h2>Hola 👋</h2>
      <p class="hint">Bienvenido/a a TaskFlow. Este es tu resumen de hoy.</p>
      <div class="home-cards">
        <div class="hc"><div class="hc-n" data-tfcount>6</div><div class="hc-l">tarjetas en tu tablero</div></div>
        <div class="hc"><div class="hc-n" data-ibcount>${unread}</div><div class="hc-l">mensajes sin leer</div></div>
        <div class="hc"><div class="hc-n">4</div><div class="hc-l">reuniones esta semana</div></div>
      </div>
      <div class="home-actions">
        <button class="btn" type="button" data-goto="tablero">Ir a mi tablero</button>
        <button class="btn ghost" type="button" data-goto="bandeja">Ver la bandeja</button>
      </div>
    </div>`;

  const viewTablero = `
    <div class="workspace">
      <div class="board-area" x-data="tfBoard()">
        <div class="board-head">
          <h2>Tareas del equipo</h2>
          <span class="pill" x-text="count + (count === 1 ? ' tarjeta' : ' tarjetas')">6 tarjetas</span>
        </div>
        <div class="columns" x-cloak>
          <template x-for="col in columns" :key="col.id">
            <div class="col" :class="{ 'col-over': overCol === col.id }"
                 @dragover.prevent="overCol = col.id" @dragleave="overCol = null" @drop.prevent="drop(col.id)">
              <div class="col-head"><span class="t" x-text="col.title"></span><span class="n" x-text="col.cards.length"></span></div>

              <template x-for="card in col.cards" :key="card.id">
                <div class="tcard" draggable="true"
                     @dragstart="drag(card.id, col.id)" @dragend="dragId = null; overCol = null">
                  <template x-if="editId === card.id">
                    <form class="tcard-edit" @submit.prevent="saveEdit(card)">
                      <textarea x-model="editText" x-ref="edit" rows="2"
                                @keydown.escape="editId = null" @keydown.enter.prevent="saveEdit(card)"></textarea>
                      <div class="tcard-actions">
                        <button class="btn tiny" type="submit">Guardar</button>
                        <button class="btn tiny ghost" type="button" @click="editId = null">Cancelar</button>
                      </div>
                    </form>
                  </template>
                  <template x-if="editId !== card.id">
                    <div>
                      <div class="tt" x-text="card.title" @dblclick="startEdit(card)" title="Doble clic para editar"></div>
                      <div class="labels" x-show="(card.labels && card.labels.length) || card.due">
                        <template x-for="lab in (card.labels || [])" :key="lab.text">
                          <span class="lab" :class="lab.cls" x-text="lab.text"></span>
                        </template>
                        <template x-if="card.due">
                          <span class="lab" :class="card.overdue ? 'due' : 'ops'" x-text="card.due"></span>
                        </template>
                      </div>
                      <div class="foot">
                        <span class="meta">
                          <span class="avatar" :style="{ background: avatar(card.who).color }" x-text="avatar(card.who).init"></span>
                          <span x-text="card.who"></span>
                        </span>
                        <span class="tcard-tools">
                          <button class="tcard-btn" type="button" @click="startEdit(card)" title="Editar">${I.pencil}</button>
                          <button class="tcard-btn" type="button" @click="removeCard(col.id, card.id)" title="Eliminar">${I.trash}</button>
                        </span>
                      </div>
                    </div>
                  </template>
                </div>
              </template>

              <template x-if="col.cards.length === 0 && addCol !== col.id">
                <div class="col-empty">Arrastra tarjetas aquí o añade una nueva.</div>
              </template>

              <template x-if="addCol === col.id">
                <form class="tcard tcard-add" @submit.prevent="addCard(col.id)">
                  <textarea x-model="addText" x-ref="add" rows="2" placeholder="Escribe una tarea…"
                            @keydown.escape="addCol = null" @keydown.enter.prevent="addCard(col.id)"></textarea>
                  <div class="tcard-actions">
                    <button class="btn tiny" type="submit">Añadir tarjeta</button>
                    <button class="btn tiny ghost" type="button" @click="addCol = null">Cancelar</button>
                  </div>
                </form>
              </template>

              <button class="col-add" type="button" x-show="addCol !== col.id" @click="startAdd(col.id)">
                ${I.plus}<span>Añadir una tarjeta</span>
              </button>
            </div>
          </template>
        </div>
      </div>
      <aside class="inbox" id="inbox">
        <h3>${I.inbox}<span>Bandeja</span><span class="ib-badge" data-ibbadge${unread ? "" : " hidden"}>${unread || ""}</span></h3>
        <div data-ibrows>${rows || emptyInbox}</div>
      </aside>
    </div>`;

  const viewBandeja = `
    <div class="inbox-full">
      <h3>Bandeja de entrada</h3>
      <div data-ibrows>${rows || emptyInbox}</div>
    </div>`;

  const viewAgenda = `
    <div class="board-head"><h2>Esta semana</h2><span class="pill">vista de ejemplo</span></div>
    <div class="agenda-grid">
      ${week.map(([d, evs]) => `<div class="day"><div class="dname">${d}</div>
        ${evs.map((e) => `<div class="ev">${escapeHtml(e)}</div>`).join("")}</div>`).join("")}
    </div>`;

  const viewEquipo = `
    <div class="board-head"><h2>Tu equipo</h2><span class="pill">${team.length} personas</span></div>
    <div class="team-grid">
      ${team.map(([nm, rl]) => `<div class="tm">${avatar(nm)}<div><div class="nm">${escapeHtml(nm)}</div><div class="rl">${escapeHtml(rl)}</div></div></div>`).join("")}
    </div>`;

  return shell("TaskFlow", `
<div class="app">
  <div class="tf-toast" id="tftoast" onclick="this.classList.remove('show')"></div>
  ${rail(active, token, true)}
  <div class="main">
    <div class="topbar">
      <h1 id="tf-title">${escapeHtml(viewTitle(active))}</h1><span class="crumb">/ Proyecto piloto</span>
      <span class="spring"></span>
      <form method="POST" action="/t/${t}/finish" style="margin:0"
        onsubmit="return confirm('¿Terminar el piloto y pasar a las preguntas finales?')">
        <button class="btn ghost" type="submit">Finalizar piloto</button>
      </form>
    </div>
    <div class="content">
      ${panel("inicio", viewInicio)}
      ${panel("tablero", viewTablero)}
      ${panel("bandeja", viewBandeja)}
      ${panel("agenda", viewAgenda)}
      ${panel("equipo", viewEquipo)}
    </div>
  </div>
</div>
<script>
var TF=${JSON.stringify(token)};
function tfPing(){try{navigator.sendBeacon('/t/'+encodeURIComponent(TF)+'/usability')}catch(e){}}

// --- Tablero kanban (Alpine.js). Estado SOLO en localStorage del participante:
//     crear / editar / borrar / arrastrar tarjetas. Nunca se envía al servidor. ---
function tfBoard(){
  var LS='tf_board_'+TF;
  var DEFAULT=${JSON.stringify(defaultBoard)};
  function uid(){ return 'k'+Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-3); }
  return {
    columns: [], dragId: null, dragFrom: null, overCol: null,
    editId: null, editText: '', addCol: null, addText: '',
    get count(){ return this.columns.reduce(function(n,c){ return n + c.cards.length; }, 0); },
    init(){
      var saved=null;
      try{ saved=JSON.parse(localStorage.getItem(LS)); }catch(e){}
      this.columns=(saved && Array.isArray(saved) && saved.length) ? saved : JSON.parse(JSON.stringify(DEFAULT));
      this.sync();
      this.$watch('columns', function(){ this.sync(); }.bind(this));
    },
    sync(){
      try{ localStorage.setItem(LS, JSON.stringify(this.columns)); }catch(e){}
      var n=this.count;
      document.querySelectorAll('[data-tfcount]').forEach(function(el){ el.textContent=n; });
    },
    avatar(name){
      var s=String(name||'?'), parts=s.split(' ').filter(Boolean);
      var init=(parts.slice(0,2).map(function(w){ return w[0]||''; }).join('')||'?').toUpperCase();
      var h=0; for(var i=0;i<s.length;i++){ h=(h*31 + s.charCodeAt(i))>>>0; }
      var c=['#4f46e5','#0f9d7a','#d97706','#db2777','#0284c7'];
      return { init: init, color: c[h % c.length] };
    },
    startAdd(colId){ this.editId=null; this.addCol=colId; this.addText=''; this.$nextTick(function(){ this.$refs.add && this.$refs.add.focus(); }.bind(this)); },
    addCard(colId){
      var text=(this.addText||'').trim(); if(!text) return;
      var col=this.columns.find(function(c){ return c.id===colId; }); if(!col) return;
      col.cards.push({ id: uid(), title: text, who: 'Tú', labels: [], due: null });
      this.addText=''; this.addCol=null; this.sync(); tfPing();
    },
    startEdit(card){ this.addCol=null; this.editId=card.id; this.editText=card.title; this.$nextTick(function(){ this.$refs.edit && this.$refs.edit.focus(); }.bind(this)); },
    saveEdit(card){ var v=(this.editText||'').trim(); if(v) card.title=v; this.editId=null; this.sync(); tfPing(); },
    removeCard(colId, cardId){
      var col=this.columns.find(function(c){ return c.id===colId; }); if(!col) return;
      col.cards=col.cards.filter(function(c){ return c.id!==cardId; });
      if(this.editId===cardId) this.editId=null;
      this.sync(); tfPing();
    },
    drag(cardId, fromId){ this.dragId=cardId; this.dragFrom=fromId; },
    drop(toId){
      this.overCol=null;
      var id=this.dragId, from=this.dragFrom;
      this.dragId=null; this.dragFrom=null;
      if(!id || from===toId) return;
      var src=this.columns.find(function(c){ return c.id===from; });
      var dst=this.columns.find(function(c){ return c.id===toId; });
      if(!src || !dst) return;
      var i=src.cards.findIndex(function(c){ return c.id===id; });
      if(i<0) return;
      dst.cards.push(src.cards.splice(i,1)[0]);
      this.sync(); tfPing();
    },
  };
}

// --- Navegación entre vistas SIN recargar la página ---
(function(){
  var TITLES=${JSON.stringify(Object.fromEntries(VIEWS.map((v) => [v.key, v.title])))};
  var base='/t/'+encodeURIComponent(TF)+'/app';
  var panels=document.querySelectorAll('[data-view-panel]');
  var navs=document.querySelectorAll('.rail .navitem');
  var titleEl=document.getElementById('tf-title');
  var mainEl=document.querySelector('.main');
  function show(v, push){
    if(!TITLES[v]) v=${JSON.stringify(DEFAULT_VIEW)};
    panels.forEach(function(p){ p.classList.toggle('active', p.getAttribute('data-view-panel')===v); });
    navs.forEach(function(n){ n.classList.toggle('active', n.getAttribute('data-view')===v); });
    if(titleEl) titleEl.textContent=TITLES[v];
    var url=base+'?v='+v;
    if(push) history.pushState({v:v},'',url); else history.replaceState({v:v},'',url);
    if(mainEl) mainEl.scrollTop=0;
  }
  navs.forEach(function(n){ n.addEventListener('click', function(){ show(n.getAttribute('data-view'), true); tfPing(); }); });
  document.querySelectorAll('[data-goto]').forEach(function(b){ b.addEventListener('click', function(){ show(b.getAttribute('data-goto'), true); tfPing(); }); });
  window.addEventListener('popstate', function(e){
    var v=(e.state && e.state.v) || new URLSearchParams(location.search).get('v') || ${JSON.stringify(DEFAULT_VIEW)};
    show(v, false);
  });
  show(new URLSearchParams(location.search).get('v') || ${JSON.stringify(DEFAULT_VIEW)}, false);
})();

// --- Bandeja en vivo: sondea cada 5 s y refresca sin recargar la página ---
(function(){
  var IB={mail:${JSON.stringify(I.mail)},task:${JSON.stringify(I.task)}};
  var base='/t/'+encodeURIComponent(TF);
  var toastEl=document.getElementById('tftoast');
  var seen={}; document.querySelectorAll('[data-ibrows] .mrow').forEach(function(a){seen[a.getAttribute('href')]=1;});
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function row(m){
    var href=base+'/d/'+encodeURIComponent(m.deliveryId);
    return '<a class="mrow msg '+(m.unread?'unread':'')+'" href="'+href+'">'
      +'<span class="ic">'+(m.kind==='task'?IB.task:IB.mail)+'</span>'
      +'<span class="bd"><span class="l1"><span class="from">'+esc(m.from)+'</span>'
      +'<span class="tag">'+(m.kind==='task'?'tarea':'correo')+'</span></span>'
      +'<span class="sj">'+esc(m.subject)+'</span><span class="pv">'+esc(m.preview)+'</span></span></a>';
  }
  function paint(items){
    var html=(items && items.length)?items.map(row).join(''):'<div class="empty">No tienes mensajes.</div>';
    document.querySelectorAll('[data-ibrows]').forEach(function(el){ el.innerHTML=html; });
  }
  function badges(n){
    document.querySelectorAll('[data-ibbadge]').forEach(function(el){ if(n){el.hidden=false;el.textContent=n;}else{el.hidden=true;el.textContent='';} });
    document.querySelectorAll('[data-ibcount]').forEach(function(el){ el.textContent=n; });
  }
  function toast(txt){ if(!toastEl)return; toastEl.textContent=txt; toastEl.classList.add('show');
    clearTimeout(toast._t); toast._t=setTimeout(function(){toastEl.classList.remove('show');},7000); }
  var fails=0, tf_iv;
  function tick(){
    if(document.hidden) return;
    fetch(base+'/inbox.json',{headers:{'Accept':'application/json'}}).then(function(r){
      if(!r.ok) throw 0; return r.json();
    }).then(function(d){
      fails=0;
      if(d.done){ clearInterval(tf_iv); return; }
      var fresh=(d.items||[]).filter(function(m){ return !seen[base+'/d/'+encodeURIComponent(m.deliveryId)]; });
      paint(d.items);
      (d.items||[]).forEach(function(m){ seen[base+'/d/'+encodeURIComponent(m.deliveryId)]=1; });
      badges(d.unread||0);
      document.title=(d.unread?'('+d.unread+') ':'')+'TaskFlow';
      if(fresh.length){ toast('Nuevo mensaje de '+fresh[0].from); }
    }).catch(function(){ if(++fails>=5) clearInterval(tf_iv); });
  }
  tf_iv=setInterval(tick,3000);
  document.addEventListener('visibilitychange',function(){ if(!document.hidden) tick(); });
})();
</script>`, {
    head: `<script defer src="/vendor/alpine.min.js"></script>`,
    extraCss: `
[x-cloak]{display:none!important}
.tf-toast{position:fixed;right:18px;bottom:18px;z-index:50;background:var(--ink);color:#fff;border-radius:10px;padding:.7rem .95rem;font-size:.85rem;line-height:1.35;box-shadow:var(--shadow-lg);max-width:320px;opacity:0;transform:translateY(10px);transition:opacity .2s,transform .2s;cursor:pointer;pointer-events:none}
.tf-toast.show{opacity:1;transform:none;pointer-events:auto}
.view{display:none}
.view.active{display:block}
.columns{min-height:140px}
.col{transition:background .12s,border-color .12s}
.col.col-over{background:var(--brand-tint);border-color:var(--brand)}
.col-add{display:flex;align-items:center;gap:.4rem;width:100%;text-align:left;background:none;border:0;color:var(--muted);font:inherit;font-size:.82rem;font-weight:500;padding:.5rem .35rem;border-radius:8px;cursor:pointer}
.col-add svg{width:14px;height:14px}
.col-add:hover{background:var(--line-soft);color:var(--ink-2)}
.col-empty{font-size:.8rem;color:var(--faint);text-align:center;padding:1rem .6rem;border:1px dashed var(--line);border-radius:9px;margin-bottom:.6rem;line-height:1.4}
.tcard .foot{align-items:center}
.tcard-tools{display:flex;gap:.1rem;opacity:0;transition:opacity .12s}
.tcard:hover .tcard-tools,.tcard:focus-within .tcard-tools{opacity:1}
.tcard-btn{background:none;border:0;cursor:pointer;color:var(--faint);padding:.2rem;border-radius:5px;display:inline-flex;align-items:center}
.tcard-btn:hover{background:var(--line-soft);color:var(--warn)}
.tcard-btn svg{width:14px;height:14px}
.tcard-edit textarea,.tcard-add textarea{width:100%;border:1px solid var(--line);border-radius:8px;padding:.45rem .55rem;font:inherit;font-size:.88rem;line-height:1.4;resize:vertical;background:#fff;color:var(--ink)}
.tcard-edit textarea:focus,.tcard-add textarea:focus{outline:2px solid var(--brand-tint);border-color:var(--brand)}
.tcard.tcard-add{box-shadow:none;border-style:dashed;cursor:default}
.tcard-actions{display:flex;gap:.4rem;margin-top:.5rem}
.btn.tiny{padding:.32rem .65rem;font-size:.78rem;border-radius:7px}
.home-view{max-width:640px}
.home-cards{display:flex;gap:1rem;flex-wrap:wrap;margin:1.1rem 0 1.4rem}
.hc{flex:1;min-width:150px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:1rem 1.15rem;box-shadow:var(--shadow-sm)}
.hc-n{font-size:1.7rem;font-weight:700;color:var(--brand-strong)}
.hc-l{font-size:.82rem;color:var(--muted);margin-top:.2rem}
.home-actions{display:flex;gap:.6rem;flex-wrap:wrap}
.inbox-full{max-width:720px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}
.inbox-full h3{margin:0;padding:.9rem 1.05rem;font-size:.95rem;font-weight:650;border-bottom:1px solid var(--line)}
.agenda-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:.7rem;margin-top:1rem}
.agenda-grid .day{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:.7rem;min-height:130px}
.agenda-grid .dname{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:.55rem}
.agenda-grid .ev{background:var(--brand-tint);color:var(--brand-strong);border-radius:6px;padding:.35rem .5rem;font-size:.76rem;margin-bottom:.4rem;line-height:1.3}
.team-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:.8rem;margin-top:1rem}
.team-grid .tm{display:flex;align-items:center;gap:.7rem;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:.8rem .9rem}
.team-grid .nm{font-weight:600;font-size:.9rem}
.team-grid .rl{font-size:.78rem;color:var(--muted)}
@media(max-width:720px){.agenda-grid{grid-template-columns:repeat(2,1fr)}}
` });
}

export function renderMessage(token, msg) {
  const t = encodeURIComponent(token);
  const d = encodeURIComponent(msg.deliveryId);
  const isAttack = msg.is_attack;
  const bodyHtml = isAttack ? sanitizeMessageHtml(msg.body) : `<p>${escapeHtml(msg.body).replace(/\n/g, "<br>")}</p>`;
  const actions = isAttack ? `
    <div class="actions">
      <a class="btn" href="/t/${t}/d/${d}/go">${escapeHtml(msg.cta_label || "Abrir")}</a>
      <button class="btn subtle" type="button"
        onclick="fetch('/t/${t}/d/${d}/report',{method:'POST'}).then(()=>{this.textContent='Reportado ✓';this.disabled=true})">
        Reportar como sospechoso
      </button>
    </div>` : "";

  return shell(msg.subject, `
<div class="app">
  ${rail("bandeja", token, false)}
  <div class="main">
    <div class="topbar"><h1>Bandeja</h1><span class="crumb">/ ${escapeHtml(msg.kind === "task" ? "Tarea" : "Mensaje")}</span></div>
    <div class="content">
      <div class="reader">
        <a class="back" href="/t/${t}/app?v=bandeja">${I.back} Volver a la bandeja</a>
        <div class="card">
          <div class="hd">
            <div class="kind">${msg.kind === "task" ? "Tarea asignada" : "Mensaje recibido"}</div>
            <h1>${escapeHtml(msg.subject)}</h1>
            <div class="who">${avatar(msg.from)} <span><strong>${escapeHtml(msg.from)}</strong> · para ti</span></div>
          </div>
          <div class="bd">${bodyHtml}</div>
          ${actions}
        </div>
      </div>
    </div>
  </div>
</div>`);
}

export function renderStimulusLanding(token, delivery) {
  const t = encodeURIComponent(token);
  const d = encodeURIComponent(delivery.deliveryId);

  if (delivery.landing_kind === "permiso") {
    const cfg = delivery.landing_config || {};
    const scope = cfg.scope || cfg.permiso || "perfil";
    const labels = {
      perfil: "Ver tu nombre y foto de perfil",
      tareas: "Ver y editar tus tareas y tableros",
      agenda: "Ver los eventos de tu agenda",
      equipo: "Ver la lista de miembros de tu equipo",
      archivos: "Ver los archivos compartidos contigo",
    };
    return shell("TaskFlow — Autorización", `
<div class="authwrap">
  <div class="authcard">
    <div class="hd">
      <div class="logos">${LOGO}</div>
      <h1>${escapeHtml(cfg.titulo || "Una aplicación solicita acceso a tu cuenta de TaskFlow")}</h1>
    </div>
    <div class="bd">
      <p style="margin:.2rem 0 .3rem;color:var(--muted);font-size:.86rem">Esta aplicación podrá:</p>
      <ul class="scopes">
        <li>${I.check}<span>${escapeHtml(labels[scope] || `Acceso: ${scope}`)}</span></li>
        ${cfg.detalle ? `<li>${I.check}<span>${escapeHtml(cfg.detalle)}</span></li>` : ""}
      </ul>
    </div>
    <div class="ft">
      <button class="btn ghost" onclick="location.href='/t/${t}/app'">Cancelar</button>
      <form method="POST" action="/t/${t}/d/${d}/authorize" style="flex:1;margin:0">
        <input type="hidden" name="scope" value="${escapeHtml(scope)}">
        <button class="btn block" type="submit">Autorizar</button>
      </form>
    </div>
  </div>
</div>
<p class="note" style="text-align:center;margin-top:1rem">Ejercicio académico · no se accede realmente a ninguna cuenta ni recurso.</p>`);
  }

  const cfg = delivery.landing_config || {};
  return shell("TaskFlow — Verificación", `
<div class="plate">
  <div class="sheet">
    <div class="brand">${LOGO} TaskFlow</div>
    <h1>${escapeHtml(cfg.titulo || "Verifica tu identidad")}</h1>
    <p class="sub">${escapeHtml(cfg.detalle || "Vuelve a introducir tus datos de acceso para continuar.")}</p>
    <form id="f" method="POST" action="/t/${t}/d/${d}/submit">
      <div class="field"><label>Usuario o correo</label><input type="text" name="u" autocomplete="off"></div>
      <div class="field"><label>Contraseña</label><input type="password" name="p" autocomplete="off"></div>
      <button class="btn block" type="submit">Continuar</button>
    </form>
    <p class="note">Al enviar <strong>no se guarda lo que escribas</strong>; solo queda registrado
    que se intentó enviar (ejercicio académico).</p>
  </div>
</div>
<script>
document.getElementById('f').addEventListener('submit',function(e){
  e.preventDefault();e.target.reset();
  fetch('/t/${t}/d/${d}/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
   .then(function(){location.href='/t/${t}/action-done'});
});
</script>`);
}

export function renderActionDone(token) {
  const t = encodeURIComponent(token);
  return shell("TaskFlow", `
<div class="plate">
  <div class="sheet" style="text-align:center">
    <div class="donemark">${I.check}</div>
    <h1>Listo</h1>
    <p class="sub">Hemos registrado tu solicitud. Puedes seguir usando TaskFlow con normalidad.</p>
    <div style="display:flex;gap:.6rem;justify-content:center;margin-top:1.3rem;flex-wrap:wrap">
      <a class="btn ghost" href="/t/${t}/app">Volver al tablero</a>
      <form method="POST" action="/t/${t}/finish" style="margin:0"
        onsubmit="return confirm('¿Terminar el piloto y pasar a las preguntas finales?')">
        <button class="btn" type="submit">Finalizar piloto</button>
      </form>
    </div>
  </div>
</div>`);
}

export function renderSurvey(token, schema) {
  const t = encodeURIComponent(token);
  const vq = schema.vector_question, cq = schema.common;
  const radio = (name, q) => `
    <fieldset>
      <legend>${escapeHtml(q.text)}</legend>
      ${q.options.map((o) => {
        const v = typeof o === "string" ? o : o.value, l = typeof o === "string" ? o : o.label;
        return `<label class="opt"><input type="radio" name="${name}" value="${escapeHtml(v)}" required> <span>${escapeHtml(l)}</span></label>`;
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
<div class="plate">
  <div class="sheet wide survey">
    <div class="brand">${LOGO} TaskFlow</div>
    <h1>Unas preguntas para terminar</h1>
    <p class="sub">No hay respuestas correctas ni incorrectas. Nos ayuda a entender tu experiencia.</p>
    <form method="POST" action="/t/${t}/survey">
      ${radio("perceived_suspicion_before_action", cq.perceived_suspicion_before_action)}
      ${radio("vector_specific_answer", vq)}
      ${select("fall_reason", cq.fall_reason, schema.default_reason)}
      ${radio("recognized_as_simulated", cq.recognized_as_simulated)}
      <fieldset>
        <legend>¿Quieres añadir algo? (opcional)</legend>
        <div class="field"><textarea name="free_comment" rows="3" maxlength="1000" placeholder="Comentario libre..."></textarea></div>
      </fieldset>
      <button class="btn block" type="submit">Enviar respuestas</button>
    </form>
  </div>
</div>`);
}

export function renderDebrief(html) {
  return shell("Información sobre el estudio", `
<div class="debrief">
  <div class="card">
    <div class="brand" style="display:flex;align-items:center;gap:.5rem;font-weight:700;margin-bottom:1rem">${LOGO} TaskFlow</div>
    <h1>Información sobre el estudio</h1>
    <p>${html.replace(/\n\n/g, "</p><p>")}</p>
    <p style="margin-top:1.5rem;color:var(--faint);font-size:.9rem">Ya puedes cerrar esta pestaña. Gracias por tu participación.</p>
  </div>
</div>
<script>try{for(var i=localStorage.length-1;i>=0;i--){var k=localStorage.key(i);if(k&&k.indexOf('tf_board_')===0)localStorage.removeItem(k);}}catch(e){}</script>`);
}

export function renderInvalid(msg) {
  return shell("Enlace no válido", `
<div class="plate"><div class="sheet" style="text-align:center">
  <div class="brand" style="justify-content:center">${LOGO} TaskFlow</div>
  <h1>Enlace no válido</h1>
  <p class="sub">${escapeHtml(msg || "Este enlace no es válido o ya ha caducado.")}</p>
</div></div>`);
}
