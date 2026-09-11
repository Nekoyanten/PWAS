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

// Etiqueta <script> que activa apps/api/public/js/behavior-capture.js en
// una pantalla del participante (Tabla 1 §8.2.1, fila 1). `phase` identifica
// qué pantalla es para el análisis posterior; `deliveryId` (opcional) ata la
// captura a un mensaje/ataque concreto cuando aplica (mensaje, landing).
// Un solo lugar para esto: agregar una fase nueva más adelante (p.ej. el
// debrief) es una línea acá, no cuatro copias del mismo <script> repetidas.
function behaviorCaptureTag(token, phase, deliveryId) {
  const attrs = [`data-token="${escapeHtml(token)}"`, `data-phase="${escapeHtml(phase)}"`];
  if (deliveryId) attrs.push(`data-delivery-id="${escapeHtml(deliveryId)}"`);
  return `<script src="/js/behavior-capture.js" ${attrs.join(" ")}></script>`;
}

function shell(title, bodyHtml, opts = {}) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap" rel="stylesheet">
${opts.head || ""}
<style>${BASE_CSS}${opts.extraCss || ""}</style></head><body class="${opts.bodyClass || ""}">${bodyHtml}</body></html>`;
}

const BASE_CSS = `
/* ═══ "Modernist" — tokens adoptados del prototipo TaskFlow colaborativa:
   fondo cálido neutro, acento naranja/rojo, tipografía Archivo, bordes
   rectos (radio 0). Cambiar el LOOK entero de la app señuelo es, adrede,
   solo esto: retintar las mismas variables que ya usaba cada componente
   (.btn, .col, .tcard, .rail, etc.) en vez de reescribir cada selector uno
   por uno — así el rediseño no le toca el comportamiento a nada. ═══ */
:root{
  --bg:#f3f2f2; --panel:#eae7e7; --surface:#ffffff; --line:rgba(32,30,29,.22); --line-soft:rgba(32,30,29,.1);
  --ink:#201e1d; --ink-2:#3a3735; --muted:#6b6663; --faint:#9b9797;
  --brand:#ec3013; --brand-strong:#ae1800; --brand-tint:#fff2ef;
  --ok:#12805c; --warn:#b91c1c;
  --radius:0px; --radius-sm:0px;
  --shadow-sm:0 1px 2px rgba(32,30,29,.10);
  --shadow:0 1px 2px rgba(32,30,29,.08),0 6px 20px rgba(32,30,29,.10);
  --shadow-lg:0 12px 44px rgba(32,30,29,.20);
}
*{box-sizing:border-box}
html,body{height:100%}
body{font-family:"Archivo",system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;font-size:14px;line-height:1.5}
a{color:var(--brand);text-decoration:none}
a:hover{color:var(--brand-strong)}
h1,h2,h3{letter-spacing:-.015em;font-weight:800}
button{font:inherit}
.eyebrow{font-size:.68rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}

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

/* ---------- panel lateral de Mis tableros: pestañas Bandeja/Chat ---------- */
.tf-side{display:flex;flex-direction:column;max-height:calc(100vh - 140px)}
.side-tabs{display:flex;border-bottom:1px solid var(--line);flex:none}
.side-tab{flex:1;display:flex;align-items:center;justify-content:center;gap:.4rem;padding:.8rem .5rem;background:none;border:0;border-bottom:2px solid transparent;font:inherit;font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);cursor:pointer}
.side-tab svg{width:15px;height:15px}
.side-tab.active{color:var(--brand-strong);border-bottom-color:var(--brand)}
.side-tab .ib-badge{margin-left:0}
.side-scroll{overflow-y:auto;flex:1;min-height:0}
.side-chat{display:flex;flex-direction:column;flex:1;min-height:0}
.side-chat .chat-scroll{padding:.7rem .9rem}
.side-chat .chat-input{padding:.6rem .8rem;margin:0}

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
.quick-replies{padding:0 1.5rem 1.45rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.quick-replies .qr-label{font-size:.78rem;color:var(--muted);width:100%;margin-bottom:.15rem}

/* ---------- tableros (multi-board, migración 010) ---------- */
.board-tabs{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;margin-bottom:.9rem}
.board-tab{padding:.4rem .85rem;border-radius:20px;border:1px solid var(--line);background:var(--surface);font-size:.82rem;font-weight:600;color:var(--muted);cursor:pointer}
.board-tab.active{background:var(--brand-tint);color:var(--brand-strong);border-color:var(--brand-tint)}
.board-tab-new{padding:.4rem .7rem;border-radius:20px;border:1px dashed var(--line);background:transparent;font-size:.82rem;color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;gap:.3rem}
.board-tab-new svg{width:14px;height:14px}
.responsible-select{width:100%;margin-top:.4rem;font-size:.78rem;padding:.3rem .45rem;border:1px solid var(--line);border-radius:7px;background:#fff}
.tcard .desc{font-size:.8rem;color:var(--muted);margin-top:.25rem;line-height:1.4}
.new-board-form{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.7rem;margin-bottom:.9rem}
.new-board-form input,.new-board-form select{padding:.4rem .55rem;border:1px solid var(--line);border-radius:7px;font-size:.85rem}

/* ---------- chat (migración 010) ---------- */
.chat-wrap{max-width:640px;margin:0 auto;display:flex;flex-direction:column;height:calc(100vh - 160px)}
.chat-scroll{flex:1;overflow-y:auto;padding:.5rem .2rem;display:flex;flex-direction:column;gap:.55rem}
.bubble{max-width:75%;padding:.55rem .8rem;border-radius:14px;font-size:.9rem;line-height:1.45}
.bubble-row{display:flex;gap:.5rem;align-items:flex-end}
.bubble-row.me{flex-direction:row-reverse}
.bubble.them{background:var(--surface);border:1px solid var(--line);border-bottom-left-radius:4px}
.bubble.me{background:var(--brand);color:#fff;border-bottom-right-radius:4px}
.bubble .sender{font-size:.72rem;font-weight:650;color:var(--brand);margin-bottom:.15rem}
.bubble.attack{border:1px solid var(--warn);background:#fff8f7}
.bubble .attack-subject{font-weight:650;margin-bottom:.25rem}
.chat-input{display:flex;gap:.5rem;padding-top:.7rem;border-top:1px solid var(--line)}
.chat-input textarea{flex:1;resize:none;padding:.6rem .75rem;border:1px solid var(--line);border-radius:10px;font:inherit;font-size:.9rem}

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
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>`,
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
// "Bandeja" y "Chat de equipo" ya NO son destinos de nav aparte: viven como
// pestañas del panel lateral dentro de "Mis tableros" (ver viewTablero), al
// estilo del panel de contexto del prototipo TaskFlow colaborativa. Un
// data-goto="chat"/"bandeja" (botones de inicio) o un enlace viejo a
// ?v=chat/?v=bandeja simplemente caen a DEFAULT_VIEW ("tablero") — show()
// ya tenía ese fallback — y un evento 'tf-panel' le dice al panel lateral
// qué pestaña abrir (ver el <script> de navegación más abajo).
const VIEWS = [
  { key: "inicio", icon: I.home, label: "Inicio", title: "Inicio" },
  { key: "tablero", icon: I.board, label: "Mis tableros", title: "Mis tableros" },
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
    // El contador de sin-leer vive en "Mis tableros" (la bandeja ahora es una
    // pestaña de su panel lateral, no su propio ítem de nav — ver VIEWS).
    const badge = v.key === "tablero" ? `<span class="rail-badge" data-ibbadge hidden></span>` : "";
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

// Paso 2 del protocolo (TG §9.5): calibración de ~30s antes de la tarea de
// navegación, para fijar una línea base de la forma de usar el mouse/teclado
// de ESTE participante en particular ANTES de exponerlo a ningún estímulo
// (ningún ataque, ninguna urgencia) — así el análisis de 8.2.3 puede comparar
// "cómo se mueve normalmente" contra "cómo se mueve durante/después de un
// ataque", en vez de solo mirar el segundo dato sin punto de referencia.
//
// Dos tareas neutras, una detrás de otra, ninguna con contenido real:
//   1) Clics en un objetivo que cambia de posición al azar (línea base de
//      dinámica de MOUSE: velocidad, trayectoria, precisión).
//   2) Copiar una frase neutra en un campo de texto (línea base de dinámica
//      de TECLADO: ritmo entre teclas). La frase NUNCA se envía a ningún
//      lado — no hay ningún <form> ni fetch() que lea `value` de este campo;
//      apps/api/public/js/behavior-capture.js, que ya está activo en esta
//      pantalla (ver behaviorCaptureTag más abajo), solo registra
//      `event.code` (la tecla física), nunca el carácter ni el valor del
//      campo — mismo invariante de privacidad que el resto del proyecto.
//
// El cronómetro (como en renderJoltingInterstitial) es enteramente del lado
// del cliente: esta es una herramienta de laboratorio con un investigador
// presente, no un control de seguridad adversarial, así que se sigue el
// mismo criterio de confianza que ya usa el resto del flujo del participante
// (p.ej. "Continuar de todas formas" en la intervención tampoco se valida en
// el servidor). El servidor sí registra `calibration_started_at` /
// `calibration_completed_at`, que alcanza para poder filtrar después
// cualquier sesión sospechosamente corta si hiciera falta.
const CALIBRATION_TARGET_CLICKS = 8;
const CALIBRATION_PHRASE = "El veloz murciélago hindú comía feliz cardillo y kiwi.";

export function renderCalibration(token) {
  const t = encodeURIComponent(token);
  return shell("Calibración — TaskFlow", `
<div class="plate">
  <div class="sheet wide calib">
    <div class="brand">${LOGO} TaskFlow</div>
    <h1>Antes de comenzar</h1>
    <p class="sub">Una tarea breve (~30 s) para calibrar cómo usas el mouse y el teclado. No mide tu desempeño — no hay respuestas correctas ni incorrectas.</p>

    <div id="calib-step-mouse">
      <p>Haz clic en el círculo apenas aparezca. Se repetirá varias veces.</p>
      <div id="calib-area">
        <button type="button" id="calib-target" aria-label="Objetivo de calibración"></button>
      </div>
      <p class="note" id="calib-mouse-progress">Objetivo 1 de ${CALIBRATION_TARGET_CLICKS}</p>
    </div>

    <div id="calib-step-type" hidden>
      <p>Ahora copia esta frase en el campo de abajo (lo que escribas no se guarda, solo el ritmo al teclear):</p>
      <p style="font-weight:600;color:var(--ink)">&ldquo;${escapeHtml(CALIBRATION_PHRASE)}&rdquo;</p>
      <div class="field"><input type="text" id="calib-typing-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Escribe aquí…"></div>
    </div>

    <form method="POST" action="/t/${t}/calibration/complete" style="margin-top:.5rem">
      <button class="btn block" type="submit" id="calib-continue" disabled>Continuar (<span id="calib-count">30</span>s)</button>
    </form>
    <p class="note">Ejercicio académico autorizado · esta calibración es parte obligatoria del estudio.</p>
  </div>
</div>
<style>
.sheet.calib #calib-area{position:relative;height:210px;margin:.9rem 0;border:1px dashed var(--line);border-radius:var(--radius-sm);background:var(--panel);overflow:hidden}
.sheet.calib #calib-target{position:absolute;width:36px;height:36px;border-radius:50%;background:var(--brand);border:none;cursor:pointer;top:0;left:0;transition:background .1s}
.sheet.calib #calib-target:active{background:var(--brand-strong)}
</style>
<script>
(function(){
  var TOTAL_MS = 30000;
  var TARGET_CLICKS = ${CALIBRATION_TARGET_CLICKS};
  var area = document.getElementById('calib-area');
  var target = document.getElementById('calib-target');
  var mouseStep = document.getElementById('calib-step-mouse');
  var typeStep = document.getElementById('calib-step-type');
  var progress = document.getElementById('calib-mouse-progress');
  var btn = document.getElementById('calib-continue');
  var lbl = document.getElementById('calib-count');
  var clicks = 0;

  function moveTarget() {
    var pad = 4, w = area.clientWidth - target.offsetWidth - pad * 2, h = area.clientHeight - target.offsetHeight - pad * 2;
    target.style.left = (pad + Math.random() * Math.max(0, w)) + 'px';
    target.style.top = (pad + Math.random() * Math.max(0, h)) + 'px';
  }

  target.addEventListener('click', function () {
    clicks += 1;
    if (clicks >= TARGET_CLICKS) {
      mouseStep.hidden = true;
      typeStep.hidden = false;
      return;
    }
    progress.textContent = 'Objetivo ' + (clicks + 1) + ' de ' + TARGET_CLICKS;
    moveTarget();
  });
  moveTarget();

  var start = Date.now();
  var timer = setInterval(function () {
    var left = Math.max(0, TOTAL_MS - (Date.now() - start));
    lbl.textContent = Math.ceil(left / 1000);
    if (left <= 0) {
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = 'Continuar';
    }
  }, 100);
})();
</script>
${behaviorCaptureTag(token, "calibration")}`);
}

export function renderApp(token, { inbox, view, boardsData, contacts, boardTemplates }) {
  const t = encodeURIComponent(token);
  const unread = inbox.filter((m) => m.unread).length;
  const active = isView(view) ? view : DEFAULT_VIEW;
  const boardsInit = boardsData || [];
  const contactsInit = contacts || [];
  const boardTemplatesInit = boardTemplates || [];
  const initialTaskCount = boardsInit.reduce((n, b) => n + b.columns.reduce((m, c) => m + c.tasks.length, 0), 0);

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
        <div class="hc"><div class="hc-n" data-tfcount>${initialTaskCount}</div><div class="hc-l">tarjetas en tus tableros</div></div>
        <div class="hc"><div class="hc-n" data-ibcount>${unread}</div><div class="hc-l">mensajes sin leer</div></div>
        <div class="hc"><div class="hc-n">4</div><div class="hc-l">reuniones esta semana</div></div>
      </div>
      <div class="home-actions">
        <button class="btn" type="button" data-goto="tablero">Ir a mi tablero</button>
        <button class="btn ghost" type="button" data-goto="tablero" data-panel="bandeja">Ver la bandeja</button>
        <button class="btn ghost" type="button" data-goto="tablero" data-panel="chat">${I.chat}<span>Chat de equipo</span></button>
      </div>
    </div>`;

  const viewTablero = `
    <div class="workspace">
      <div class="board-area" x-data="tfBoards()">
        <div class="board-tabs">
          <template x-for="b in boards" :key="b.id">
            <button type="button" class="board-tab" :class="{active: activeBoard === b.id}" @click="selectBoard(b.id)" x-text="b.name"></button>
          </template>
          <button type="button" class="board-tab-new" @click="newBoardOpen = !newBoardOpen">${I.plus}<span>Nuevo tablero</span></button>
        </div>
        <template x-if="newBoardOpen">
          <form class="new-board-form" @submit.prevent="createBoard()">
            <input type="text" x-model="newBoardName" placeholder="Nombre del tablero (ej. Desarrollo de aplicativo verde)" style="flex:1;min-width:220px" required>
            <select x-model="newBoardTemplate" x-show="boardTemplates.length">
              <option value="">Tablero en blanco</option>
              <template x-for="bt in boardTemplates" :key="bt.id"><option :value="bt.id" x-text="bt.name"></option></template>
            </select>
            <button class="btn tiny" type="submit">Crear</button>
            <button class="btn tiny ghost" type="button" @click="newBoardOpen = false">Cancelar</button>
          </form>
        </template>
        <template x-if="!boards.length && !newBoardOpen">
          <div class="col-empty" style="width:auto">Todavía no tienes tableros. Crea el primero con "Nuevo tablero".</div>
        </template>
        <template x-if="board">
          <div>
            <div class="board-head">
              <h2 x-text="board.name"></h2>
              <span class="pill" x-text="count + (count === 1 ? ' tarjeta' : ' tarjetas')"></span>
            </div>
            <div class="columns" x-cloak>
              <template x-for="col in board.columns" :key="col.id">
                <div class="col" :class="{ 'col-over': overCol === col.id }"
                     @dragover.prevent="overCol = col.id" @dragleave="overCol = null" @drop.prevent="drop(col.id)">
                  <div class="col-head"><span class="t" x-text="col.name"></span><span class="n" x-text="col.tasks.length"></span></div>

                  <template x-for="task in col.tasks" :key="task.id">
                    <div class="tcard" draggable="true"
                         @dragstart="drag(task.id, col.id)" @dragend="dragId = null; overCol = null">
                      <template x-if="editId === task.id">
                        <form class="tcard-edit" @submit.prevent="saveEdit(task)">
                          <textarea x-model="editTitle" x-ref="edit" rows="2" placeholder="Título de la tarea"
                                    @keydown.escape="editId = null"></textarea>
                          <textarea x-model="editDesc" rows="2" placeholder="Descripción (qué hace esta tarea)"></textarea>
                          <select class="responsible-select" x-model="editResp">
                            <option value="">Sin responsable</option>
                            <template x-for="c in contacts" :key="c.id"><option :value="c.id" x-text="c.display_name + (c.role_label ? ' · ' + c.role_label : '')"></option></template>
                          </select>
                          <div class="prio-pick-row">
                            <template x-for="p in ['alta','media','baja']" :key="p">
                              <button type="button" class="prio-pick" :class="['prio-' + p, { active: editPriority === p }]" @click="editPriority = p" x-text="p"></button>
                            </template>
                          </div>
                          <div class="edit-checklist-label">Checklist</div>
                          <ul class="edit-checklist">
                            <template x-for="(item, i) in editChecklist" :key="i">
                              <li>
                                <label>
                                  <input type="checkbox" :checked="item.done" @change="item.done = $event.target.checked">
                                  <span x-text="item.title" :style="{ textDecoration: item.done ? 'line-through' : 'none' }"></span>
                                </label>
                                <button type="button" class="tcard-btn" @click="editChecklist.splice(i, 1)" title="Quitar ítem">${I.trash}</button>
                              </li>
                            </template>
                          </ul>
                          <div class="edit-checklist-add">
                            <input type="text" x-model="editChecklistNew" placeholder="Nuevo ítem del checklist" @keydown.enter.prevent="addEditChecklistItem()">
                            <button type="button" class="btn tiny ghost" @click="addEditChecklistItem()">+ Añadir</button>
                          </div>
                          <div class="tcard-actions">
                            <button class="btn tiny" type="submit">Guardar</button>
                            <button class="btn tiny ghost" type="button" @click="editId = null">Cancelar</button>
                          </div>
                        </form>
                      </template>
                      <template x-if="editId !== task.id">
                        <div>
                          <div class="tcard-top">
                            <span class="prio-badge" :class="'prio-' + (task.priority || 'media')" x-text="task.priority || 'media'"></span>
                          </div>
                          <div class="tt" x-text="task.title" @dblclick="startEdit(task)" title="Doble clic para editar"></div>
                          <div class="desc" x-show="task.description" x-text="task.description"></div>
                          <div class="tcard-check" x-show="(task.checklist || []).length">
                            <div class="tcard-check-label">
                              <span>Subtareas</span>
                              <span x-text="(task.checklist || []).filter(c => c.done).length + '/' + (task.checklist || []).length"></span>
                            </div>
                            <div class="tcard-check-bar"><div class="tcard-check-fill" :style="{ width: checklistPct(task) + '%' }"></div></div>
                          </div>
                          <div class="foot">
                            <span class="meta" x-show="task.responsible_contact_id">
                              <span class="avatar" :style="{ background: task.responsible_color || '#9aa1ad' }" x-text="(task.responsible_name || '?').split(' ').slice(0,2).map(w => w[0]).join('').toUpperCase()"></span>
                              <span x-text="task.responsible_name"></span>
                            </span>
                            <span class="meta" x-show="!task.responsible_contact_id" style="color:var(--faint)">Sin responsable</span>
                            <span class="tcard-tools">
                              <button class="tcard-btn" type="button" @click="startEdit(task)" title="Editar">${I.pencil}</button>
                              <button class="tcard-btn" type="button" @click="removeTask(col.id, task.id)" title="Eliminar">${I.trash}</button>
                            </span>
                          </div>
                        </div>
                      </template>
                    </div>
                  </template>

                  <template x-if="col.tasks.length === 0 && addCol !== col.id">
                    <div class="col-empty">Arrastra tarjetas aquí o añade una nueva.</div>
                  </template>

                  <template x-if="addCol === col.id">
                    <form class="tcard tcard-add" @submit.prevent="addTask(col.id)">
                      <textarea x-model="addTitle" x-ref="add" rows="2" placeholder="Título de la tarea…"
                                @keydown.escape="addCol = null"></textarea>
                      <textarea x-model="addDesc" rows="2" placeholder="Descripción (opcional)"></textarea>
                      <select class="responsible-select" x-model="addResp">
                        <option value="">Sin responsable</option>
                        <template x-for="c in contacts" :key="c.id"><option :value="c.id" x-text="c.display_name + (c.role_label ? ' · ' + c.role_label : '')"></option></template>
                      </select>
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
        </template>
      </div>
      <aside class="inbox tf-side" id="inbox" x-data="{ tab: 'bandeja' }" x-on:tf-panel.window="tab = $event.detail.tab">
        <div class="side-tabs">
          <button type="button" class="side-tab" :class="{active: tab === 'bandeja'}" @click="tab = 'bandeja'">
            ${I.inbox}<span>Bandeja</span><span class="ib-badge" data-ibbadge${unread ? "" : " hidden"}>${unread || ""}</span>
          </button>
          <button type="button" class="side-tab" :class="{active: tab === 'chat'}" @click="tab = 'chat'">
            ${I.chat}<span>Chat</span>
          </button>
        </div>
        <div x-show="tab === 'bandeja'" class="side-scroll" data-ibrows>${rows || emptyInbox}</div>
        <div x-show="tab === 'chat'" class="side-chat" x-data="tfChat()">
          <div class="chat-scroll side-scroll" x-ref="scroll">
            <template x-if="!messages.length"><div class="col-empty" style="width:auto">Cargando conversación…</div></template>
            <template x-for="m in messages" :key="m.id">
              <div class="bubble-row" :class="{me: m.kind === 'reply'}">
                <div class="bubble" :class="{them: m.kind !== 'reply', me: m.kind === 'reply', attack: m.is_attack}">
                  <div class="sender" x-show="m.kind !== 'reply' && m.sender_name" x-text="m.sender_name"></div>
                  <template x-if="m.kind === 'attack'">
                    <div>
                      <div class="attack-subject" x-text="m.attack_subject"></div>
                      <a class="btn tiny" :href="'/t/${t}/d/' + m.delivery_id" x-text="m.attack_cta || 'Abrir'"></a>
                    </div>
                  </template>
                  <template x-if="m.kind !== 'attack'"><span x-text="m.body"></span></template>
                </div>
              </div>
            </template>
          </div>
          <form class="chat-input" @submit.prevent="send()">
            <textarea x-model="draft" rows="1" placeholder="Escribe un mensaje al equipo…" @keydown.enter.prevent="send()"></textarea>
            <button class="btn" type="submit">${I.send}</button>
          </form>
        </div>
      </aside>
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
      ${panel("agenda", viewAgenda)}
      ${panel("equipo", viewEquipo)}
    </div>
  </div>
</div>
<script>
var TF=${JSON.stringify(token)};
var TF_BOARDS=${JSON.stringify(boardsInit)};
var TF_CONTACTS=${JSON.stringify(contactsInit)};
var TF_BOARD_TEMPLATES=${JSON.stringify(boardTemplatesInit)};
function tfPing(){try{navigator.sendBeacon('/t/'+encodeURIComponent(TF)+'/usability')}catch(e){}}
function tfApi(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({'Content-Type':'application/json'}, opts.headers||{});
  return fetch('/t/'+encodeURIComponent(TF)+path, opts).then(function(r){ return r.json(); });
}

// --- Tableros (Alpine.js) -- migración 010: estado real en el servidor
//     (antes: solo localStorage, invisible para el equipo). Los datos
//     iniciales vienen server-side (TF_BOARDS/TF_CONTACTS/TF_BOARD_TEMPLATES,
//     igual que la bandeja); cada mutación llama al backend y actualiza el
//     estado local con la respuesta, en vez de recargar todo el tablero. ---
function tfBoards(){
  return {
    boards: TF_BOARDS, contacts: TF_CONTACTS, boardTemplates: TF_BOARD_TEMPLATES,
    activeBoard: TF_BOARDS.length ? TF_BOARDS[0].id : null,
    dragId: null, dragFrom: null, overCol: null,
    editId: null, editTitle: '', editDesc: '', editResp: '', editPriority: 'media', editChecklist: [], editChecklistNew: '',
    addCol: null, addTitle: '', addDesc: '', addResp: '',
    newBoardOpen: false, newBoardName: '', newBoardTemplate: '',
    get board(){ var self=this; return this.boards.find(function(b){ return b.id===self.activeBoard; }) || null; },
    get count(){ var b=this.board; if(!b) return 0; return b.columns.reduce(function(n,c){ return n+c.tasks.length; }, 0); },
    init(){ this.sync(); },
    sync(){
      tfPing();
      var n=this.count;
      document.querySelectorAll('[data-tfcount]').forEach(function(el){ el.textContent=n; });
    },
    selectBoard(id){ this.activeBoard=id; },
    createBoard(){
      var name=(this.newBoardName||'').trim(); if(!name) return;
      var self=this;
      tfApi('/boards', { method:'POST', body: JSON.stringify({ name: name, template_id: this.newBoardTemplate || null }) })
        .then(function(data){
          if(!data.board) return;
          return tfApi('/boards.json').then(function(d){
            self.boards = d.boards || [];
            self.activeBoard = data.board.id;
            self.newBoardOpen=false; self.newBoardName=''; self.newBoardTemplate='';
            self.sync();
          });
        });
    },
    startAdd(colId){ this.editId=null; this.addCol=colId; this.addTitle=''; this.addDesc=''; this.addResp=''; this.$nextTick(function(){ this.$refs.add && this.$refs.add.focus(); }.bind(this)); },
    addTask(colId){
      var title=(this.addTitle||'').trim(); if(!title) return;
      var self=this, boardId=this.activeBoard;
      tfApi('/boards/'+boardId+'/tasks', { method:'POST', body: JSON.stringify({ column_id: colId, title: title, description: this.addDesc||null, responsible_contact_id: this.addResp||null }) })
        .then(function(data){
          if(!data.task) return;
          var col=self.board.columns.find(function(c){ return c.id===colId; });
          if(col) col.tasks.push(data.task);
          self.addCol=null; self.addTitle=''; self.addDesc=''; self.addResp=''; self.sync();
        });
    },
    startEdit(task){
      this.addCol=null; this.editId=task.id; this.editTitle=task.title; this.editDesc=task.description||''; this.editResp=task.responsible_contact_id||'';
      this.editPriority=task.priority||'media';
      this.editChecklist=(task.checklist||[]).map(function(item){ return { title: item.title, done: !!item.done }; });
      this.editChecklistNew='';
      this.$nextTick(function(){ this.$refs.edit && this.$refs.edit.focus(); }.bind(this));
    },
    addEditChecklistItem(){
      var title=(this.editChecklistNew||'').trim(); if(!title) return;
      this.editChecklist.push({ title: title, done: false });
      this.editChecklistNew='';
    },
    checklistPct(task){
      var list=task.checklist||[]; if(!list.length) return 0;
      return Math.round(list.filter(function(c){ return c.done; }).length / list.length * 100);
    },
    saveEdit(task){
      var self=this, boardId=this.activeBoard;
      tfApi('/boards/'+boardId+'/tasks/'+task.id, {
        method:'PATCH',
        body: JSON.stringify({
          title: this.editTitle, description: this.editDesc, responsible_contact_id: this.editResp||null,
          priority: this.editPriority, checklist: this.editChecklist,
        }),
      }).then(function(data){
          if(data.task){
            task.title=data.task.title; task.description=data.task.description; task.responsible_contact_id=data.task.responsible_contact_id;
            task.priority=data.task.priority; task.checklist=data.task.checklist;
            var c=self.contacts.find(function(x){ return x.id===task.responsible_contact_id; });
            task.responsible_name = c ? c.display_name : null; task.responsible_color = c ? c.avatar_color : null;
          }
          self.editId=null; self.sync();
        });
    },
    removeTask(colId, taskId){
      var self=this, boardId=this.activeBoard;
      tfApi('/boards/'+boardId+'/tasks/'+taskId, { method:'DELETE' }).then(function(){
        var col=self.board.columns.find(function(c){ return c.id===colId; });
        if(col) col.tasks = col.tasks.filter(function(t){ return t.id!==taskId; });
        if(self.editId===taskId) self.editId=null;
        self.sync();
      });
    },
    drag(taskId, fromColId){ this.dragId=taskId; this.dragFrom=fromColId; },
    drop(toColId){
      this.overCol=null;
      var id=this.dragId, from=this.dragFrom;
      this.dragId=null; this.dragFrom=null;
      if(!id || from===toColId) return;
      var b=this.board; if(!b) return;
      var src=b.columns.find(function(c){ return c.id===from; });
      var dst=b.columns.find(function(c){ return c.id===toColId; });
      if(!src || !dst) return;
      var i=src.tasks.findIndex(function(t){ return t.id===id; });
      if(i<0) return;
      var task=src.tasks.splice(i,1)[0];
      dst.tasks.push(task);
      this.sync();
      tfApi('/boards/'+this.activeBoard+'/tasks/'+id, { method:'PATCH', body: JSON.stringify({ column_id: toColId }) });
    },
  };
}

// --- Chat persistente (Alpine.js) -- migración 010: hilo real por
//     participante, con conversación ambiente (guion del admin) + ataques
//     inyectados + lo que el participante escribe. Se instancia en el
//     servidor la primera vez que se pide (ver GET /:token/chat.json). ---
function tfChat(){
  return {
    messages: [], draft: '', loaded: false,
    init(){
      var self=this;
      tfApi('/chat.json').then(function(d){
        self.messages = d.messages || [];
        self.loaded = true;
        self.$nextTick(function(){ self.scrollDown(); });
      });
    },
    scrollDown(){ if(this.$refs.scroll) this.$refs.scroll.scrollTop = this.$refs.scroll.scrollHeight; },
    send(){
      var body=(this.draft||'').trim(); if(!body) return;
      var self=this;
      tfApi('/chat/reply', { method:'POST', body: JSON.stringify({ body: body }) }).then(function(data){
        if(data.message) self.messages.push(data.message);
        self.draft='';
        tfPing();
        self.$nextTick(function(){ self.scrollDown(); });
      });
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
  document.querySelectorAll('[data-goto]').forEach(function(b){ b.addEventListener('click', function(){
    show(b.getAttribute('data-goto'), true);
    // data-panel abre una pestaña concreta del panel lateral de "Mis
    // tableros" (Bandeja/Chat) -- ver la nota junto a VIEWS más arriba.
    var panelTab = b.getAttribute('data-panel');
    if (panelTab) window.dispatchEvent(new CustomEvent('tf-panel', { detail: { tab: panelTab } }));
    tfPing();
  }); });
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
</script>
${behaviorCaptureTag(token, "app")}`, {
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

/* ---------- prioridad y checklist de tarjeta (migración 013) ---------- */
.tcard-top{display:flex;gap:.35rem;flex-wrap:wrap;margin-bottom:.4rem}
.prio-badge{font-size:.62rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:.1rem .45rem;border:1.5px solid;border-radius:20px}
.prio-badge.prio-alta,.prio-pick.prio-alta.active{color:var(--warn);border-color:var(--warn)}
.prio-badge.prio-media,.prio-pick.prio-media.active{color:var(--brand-strong);border-color:var(--brand)}
.prio-badge.prio-baja,.prio-pick.prio-baja.active{color:var(--muted);border-color:var(--line)}
.prio-pick.prio-alta.active{background:#fdeaea}
.prio-pick.prio-media.active{background:var(--brand-tint)}
.prio-pick.prio-baja.active{background:var(--line-soft)}
.tcard-check{margin-top:.55rem}
.tcard-check-label{display:flex;justify-content:space-between;font-size:.7rem;color:var(--muted);margin-bottom:.2rem}
.tcard-check-bar{height:4px;background:var(--line-soft);border-radius:3px;overflow:hidden}
.tcard-check-fill{height:100%;background:var(--ink-2);transition:width .25s}
.prio-pick-row{display:flex;gap:.35rem;margin-top:.5rem}
.prio-pick{flex:1;font-size:.68rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:.3rem .3rem;border:1.5px solid var(--line);border-radius:6px;background:#fff;color:var(--muted);cursor:pointer}
.edit-checklist-label{font-size:.72rem;font-weight:650;color:var(--muted);margin-top:.6rem;margin-bottom:.2rem}
.edit-checklist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.1rem}
.edit-checklist li{display:flex;align-items:center;justify-content:space-between;gap:.4rem;padding:.15rem 0}
.edit-checklist label{display:flex;align-items:center;gap:.4rem;font-size:.82rem;min-width:0}
.edit-checklist label span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.edit-checklist-add{display:flex;gap:.4rem;margin-top:.35rem}
.edit-checklist-add input{flex:1;min-width:0;padding:.35rem .5rem;border:1px solid var(--line);border-radius:7px;font-size:.82rem}
.btn.tiny{padding:.32rem .65rem;font-size:.78rem;border-radius:7px}
.home-view{max-width:640px}
.home-cards{display:flex;gap:1rem;flex-wrap:wrap;margin:1.1rem 0 1.4rem}
.hc{flex:1;min-width:150px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:1rem 1.15rem;box-shadow:var(--shadow-sm)}
.hc-n{font-size:1.7rem;font-weight:700;color:var(--brand-strong)}
.hc-l{font-size:.82rem;color:var(--muted);margin-top:.2rem}
.home-actions{display:flex;gap:.6rem;flex-wrap:wrap}
.home-actions svg{width:15px;height:15px}
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
  // Árbol de respuestas (migración 010): botones de respuesta rápida
  // prediseñados por el admin (message_branches), junto a "Abrir"/"Reportar".
  // Elegir uno crea el siguiente mensaje de la conversación -- ver
  // POST /d/:deliveryId/branch. No es un chatbot que interprete texto libre:
  // cada botón es una acción fija y auditable.
  const replies = (msg.branches || []).length ? `
    <div class="quick-replies">
      <div class="qr-label">Responder:</div>
      ${msg.branches.map((b) => `
        <button class="btn ghost tiny" type="button" data-branch="${escapeHtml(b.action_key)}"
          onclick="tfBranch('${d}', '${escapeHtml(b.action_key)}', this)">${escapeHtml(b.action_label)}</button>
      `).join("")}
    </div>` : "";
  const actions = isAttack ? `
    <div class="actions">
      <a class="btn" href="/t/${t}/d/${d}/go">${escapeHtml(msg.cta_label || "Abrir")}</a>
      <button class="btn subtle" type="button"
        onclick="fetch('/t/${t}/d/${d}/report',{method:'POST'}).then(()=>{this.textContent='Reportado ✓';this.disabled=true})">
        Reportar como sospechoso
      </button>
    </div>${replies}` : "";

  return shell(msg.subject, `
<div class="app">
  ${rail("tablero", token, false)}
  <div class="main">
    <div class="topbar"><h1>Bandeja</h1><span class="crumb">/ ${escapeHtml(msg.kind === "task" ? "Tarea" : "Mensaje")}</span></div>
    <div class="content">
      <div class="reader">
        <a class="back" href="/t/${t}/app?v=tablero">${I.back} Volver a la bandeja</a>
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
</div>
<script>
function tfBranch(deliveryId, actionKey, btn){
  btn.disabled = true;
  fetch('/t/${t}/d/'+deliveryId+'/branch', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({action_key: actionKey})
  }).then(function(r){ return r.json(); }).then(function(data){
    if (data && data.error) { btn.disabled = false; alert(data.error); return; }
    var box = btn.closest('.quick-replies');
    if (box) box.innerHTML = '<div class="qr-label">Respondiste. Revisa tu bandeja o tu chat para ver la respuesta.</div>';
  }).catch(function(){ btn.disabled = false; });
}
</script>
${behaviorCaptureTag(token, "message", msg.deliveryId)}`);
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
<p class="note" style="text-align:center;margin-top:1rem">Ejercicio académico · no se accede realmente a ninguna cuenta ni recurso.</p>
${behaviorCaptureTag(token, "landing", delivery.deliveryId)}`);
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
</script>
${behaviorCaptureTag(token, "landing", delivery.deliveryId)}`);
}

// Capa de intervención PAWS (jolting cognitivo, TG §8.2.5). Se muestra solo
// al grupo experimental, una vez por delivery, antes del aterrizaje real:
//  - Pausa obligatoria de 1,5-2 s (retraso racional / pause-before-action)
//    durante la cual el botón "Continuar de todas formas" está inhabilitado.
//  - Saliencia adaptativa: alterna dos estilos de alerta (fuente ampliada +
//    contraste rojo, o icono con parpadeo) según el delivery, para no generar
//    siempre el mismo estímulo y reducir la habituación.
//  - Aviso sonoro breve (Web Audio API) al aparecer, sin hardware háptico.
//  - "Cancelar" siempre disponible de inmediato: es la forma en que este
//    prototipo de software revierte la acción de riesgo (no existe forma
//    segura de bloquear el clic ya ejecutado, así que se previene el
//    siguiente paso en vez de revertir uno ya hecho).
export function renderJoltingInterstitial(token, { deliveryId }) {
  const t = encodeURIComponent(token);
  const d = encodeURIComponent(deliveryId);
  // Alternancia determinista por delivery (misma idea que assignBalanced: no
  // depender de Math.random para poder probarlo).
  let h = 0; for (const c of String(deliveryId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const salientStyle = h % 2 === 0 ? "scale" : "pulse";
  const pauseMs = 1500 + (h % 6) * 100; // 1500-2000 ms, TG §8.2.5

  return shell("Un momento", `
<div class="plate">
  <div class="sheet jolt jolt-${salientStyle}" role="alert" aria-live="assertive">
    <div class="brand">${LOGO} TaskFlow</div>
    <h1>⚠ Espera un momento antes de continuar</h1>
    <p class="sub">Este enlace tiene características de un mensaje de riesgo (remitente, urgencia o solicitud inusual). Tómate un segundo para revisarlo.</p>
    <ul style="margin:.9rem 0;padding-left:1.1rem;color:var(--ink-2);font-size:.9rem;line-height:1.6">
      <li>¿Esperabas este mensaje?</li>
      <li>¿El remitente es quien dice ser?</li>
      <li>¿Te está apurando a actuar ya mismo?</li>
    </ul>
    <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.2rem">
      <form method="POST" action="/t/${t}/d/${d}/cancel" style="margin:0">
        <button class="btn ghost" type="submit">Cancelar y volver</button>
      </form>
      <form method="POST" action="/t/${t}/d/${d}/proceed" style="margin:0">
        <button class="btn" type="submit" id="jolt-continue" disabled>Continuar de todas formas (<span id="jolt-count">${(pauseMs / 1000).toFixed(1)}</span>s)</button>
      </form>
    </div>
    <p class="note">Ejercicio académico autorizado · esta pausa es intencional.</p>
  </div>
</div>
<style>
.jolt.jolt-scale h1{font-size:1.6rem;color:var(--warn)}
.jolt.jolt-pulse h1{color:var(--warn);animation:joltpulse 1s ease-in-out infinite}
@keyframes joltpulse{0%,100%{opacity:1}50%{opacity:.55}}
.jolt{border:2px solid var(--warn)}
</style>
<script>
(function(){
  var ms = ${pauseMs};
  var btn = document.getElementById('jolt-continue');
  var lbl = document.getElementById('jolt-count');
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      var ctx = new Ctx(), osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = 660; gain.gain.value = 0.05;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.18);
    }
  } catch (e) {}
  var start = Date.now();
  var timer = setInterval(function(){
    var left = Math.max(0, ms - (Date.now() - start));
    lbl.textContent = (left / 1000).toFixed(1);
    if (left <= 0) {
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = 'Continuar de todas formas';
    }
  }, 100);
})();
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
</div>
${behaviorCaptureTag(token, "survey")}`);
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
