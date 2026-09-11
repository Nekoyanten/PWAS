import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

// Rutas de ADMINISTRACIÓN (requireAdmin) para el módulo de interacción
// ampliada (migración 010): compañeros ficticios, plantillas de tablero,
// guiones de chat y árbol de respuestas. Las rutas que usa el PARTICIPANTE
// (crear/editar su propio tablero, ver y contestar su chat, seguir una
// rama) están en tracking.js, junto con el resto del flujo del participante
// — no acá, para no mezclar las dos superficies de autenticación (x-api-key
// vs. token de un solo uso).
export const interactionRouter = Router();

// ---------------------------------------------------------------------------
// Compañeros de equipo ficticios (nombre realista, nadie real detrás — ver
// comentario de la tabla en la migración 010).
interactionRouter.post("/campaigns/:id/contacts", requireAdmin, async (req, res) => {
  const { display_name, role_label, avatar_color } = req.body ?? {};
  if (!display_name) return res.status(400).json({ error: "Falta 'display_name'" });
  const c = await query(`SELECT id FROM campaigns WHERE id = $1`, [req.params.id]);
  if (c.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  const r = await query(
    `INSERT INTO fictitious_contacts (campaign_id, display_name, role_label, avatar_color)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.params.id, display_name, role_label ?? null, avatar_color ?? null]
  );
  res.status(201).json({ contact: r.rows[0] });
});

interactionRouter.get("/campaigns/:id/contacts", requireAdmin, async (req, res) => {
  const r = await query(
    `SELECT * FROM fictitious_contacts WHERE campaign_id = $1 ORDER BY created_at`,
    [req.params.id]
  );
  res.json({ contacts: r.rows });
});

interactionRouter.delete("/contacts/:id", requireAdmin, async (req, res) => {
  try {
    const r = await query(`DELETE FROM fictitious_contacts WHERE id = $1 RETURNING id`, [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Contacto no encontrado" });
    res.json({ deleted: r.rows[0].id });
  } catch {
    res.status(409).json({ error: "No se puede borrar: el contacto está en uso (tareas o mensajes de chat)." });
  }
});

// Un pequeño elenco fijo de compañeros ficticios, reusado por las tres
// "semillas de un clic" de abajo (compañeros, plantillas de tablero, guiones
// de chat) para que el admin no tenga que escribir nada a mano para
// arrancar -- pedido explícito del usuario: "que solo tengamos que
// presionar y no crearlas totalmente". Mismo patrón que
// templates.js::STANDARD_LIBRARY (biblioteca estándar de mensajes), pero
// para el módulo de interacción.
const DEFAULT_CONTACTS = [
  { display_name: "Andrés Gómez", role_label: "Compañero de equipo", avatar_color: "#ec3013" },
  { display_name: "Laura Méndez", role_label: "Líder de proyecto", avatar_color: "#4f46e5" },
  { display_name: "Marcela Ruiz", role_label: "Diseño de producto", avatar_color: "#12805c" },
  { display_name: "Diego Torres", role_label: "Desarrollo", avatar_color: "#0ea5e9" },
  { display_name: "Sofía Ramírez", role_label: "Coordinación", avatar_color: "#f59e0b" },
];

// Trae o crea (idempotente por nombre dentro de la campaña) uno de los
// compañeros del elenco de arriba. Se usa tanto para sembrar la lista de
// compañeros como, de paso, para resolver "responsable"/"remitente" al
// sembrar plantillas de tablero o guiones de chat -- así cualquiera de los
// tres botones funciona solo, sin depender de que el admin haya apretado los
// otros dos antes.
async function ensureContact(campaignId, displayName) {
  const existing = await query(
    `SELECT id FROM fictitious_contacts WHERE campaign_id = $1 AND display_name = $2`,
    [campaignId, displayName]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;
  const meta = DEFAULT_CONTACTS.find((c) => c.display_name === displayName) || {};
  const r = await query(
    `INSERT INTO fictitious_contacts (campaign_id, display_name, role_label, avatar_color) VALUES ($1,$2,$3,$4) RETURNING id`,
    [campaignId, displayName, meta.role_label ?? null, meta.avatar_color ?? null]
  );
  return r.rows[0].id;
}

interactionRouter.post("/campaigns/:id/contacts/seed-defaults", requireAdmin, async (req, res) => {
  const c = await query(`SELECT id FROM campaigns WHERE id = $1`, [req.params.id]);
  if (c.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  const created = [];
  for (const d of DEFAULT_CONTACTS) {
    const before = await query(
      `SELECT id FROM fictitious_contacts WHERE campaign_id = $1 AND display_name = $2`,
      [req.params.id, d.display_name]
    );
    const skipped = before.rows.length > 0;
    const id = await ensureContact(req.params.id, d.display_name);
    created.push({ id, display_name: d.display_name, skipped });
  }
  res.status(201).json({ contacts: created, total: created.length });
});

// ---------------------------------------------------------------------------
// Plantillas de tablero (semilla de columnas + tareas a clonar).
// priority/checklist (migración 013) son opcionales en la semilla -- si
// faltan, boards.createBoard ya les pone "media"/"[]" por defecto al
// clonar -- pero si vienen, se valida su forma acá para no guardar una
// plantilla que después falle (o se sanee en silencio) al instanciarse.
const VALID_SEED_PRIORITIES = new Set(["alta", "media", "baja"]);
function validateBoardSeed(seed) {
  if (!Array.isArray(seed)) return "seed debe ser un arreglo de columnas";
  for (const col of seed) {
    if (!col || typeof col.name !== "string" || !col.name.trim()) return "cada columna necesita 'name'";
    if (col.tasks !== undefined && !Array.isArray(col.tasks)) return "'tasks' debe ser un arreglo";
    for (const t of col.tasks ?? []) {
      if (!t || typeof t.title !== "string" || !t.title.trim()) return "cada tarea necesita 'title'";
      if (t.priority !== undefined && !VALID_SEED_PRIORITIES.has(t.priority)) {
        return "la prioridad de una tarea debe ser 'alta', 'media' o 'baja'";
      }
      if (t.checklist !== undefined) {
        if (!Array.isArray(t.checklist)) return "el checklist de una tarea debe ser un arreglo";
        for (const item of t.checklist) {
          if (!item || typeof item.title !== "string" || !item.title.trim()) return "cada ítem del checklist necesita 'title'";
        }
      }
    }
  }
  return null;
}

interactionRouter.post("/campaigns/:id/board-templates", requireAdmin, async (req, res) => {
  const { name, seed } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "Falta 'name'" });
  const err = validateBoardSeed(seed ?? []);
  if (err) return res.status(400).json({ error: err });
  const c = await query(`SELECT id FROM campaigns WHERE id = $1`, [req.params.id]);
  if (c.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  const r = await query(
    `INSERT INTO board_templates (campaign_id, name, seed) VALUES ($1, $2, $3::jsonb) RETURNING *`,
    [req.params.id, name, JSON.stringify(seed ?? [])]
  );
  res.status(201).json({ board_template: r.rows[0] });
});

interactionRouter.get("/campaigns/:id/board-templates", requireAdmin, async (req, res) => {
  const r = await query(`SELECT * FROM board_templates WHERE campaign_id = $1 ORDER BY created_at`, [req.params.id]);
  res.json({ board_templates: r.rows });
});

// Dos tableros de ejemplo ya armados (columnas, tareas, prioridad y
// checklist reales -- migración 013), con el "responsable" resuelto contra
// el elenco de DEFAULT_CONTACTS de arriba (se crea el compañero si hace
// falta). Igual que la biblioteca estándar de plantillas: es de un clic, y
// no requiere haber sembrado los compañeros por separado antes.
const DEFAULT_BOARD_TEMPLATES = [
  { name: "Lanzamiento de producto Q4", columns: [
    { name: "Por hacer", tasks: [
      { title: "Definir alcance del lanzamiento", responsible_name: "Laura Méndez", priority: "alta",
        checklist: [{ title: "Confirmar fecha con Dirección", done: false }, { title: "Listar funciones incluidas", done: false }] },
      { title: "Preparar material de comunicación", responsible_name: "Marcela Ruiz", priority: "media",
        checklist: [{ title: "Boceto del anuncio", done: false }] },
    ] },
    { name: "En curso", tasks: [
      { title: "Desarrollar la función principal", responsible_name: "Diego Torres", priority: "alta",
        checklist: [{ title: "Backend", done: true }, { title: "Frontend", done: false }, { title: "Pruebas", done: false }] },
    ] },
    { name: "Hecho", tasks: [
      { title: "Reservar la sala para el lanzamiento", responsible_name: "Sofía Ramírez", priority: "baja", checklist: [] },
    ] },
  ] },
  { name: "Sprint semanal de soporte", columns: [
    { name: "Por hacer", tasks: [
      { title: "Revisar tickets pendientes de la semana", responsible_name: "Andrés Gómez", priority: "media", checklist: [] },
    ] },
    { name: "En curso", tasks: [
      { title: "Responder consultas del equipo de ventas", responsible_name: "Sofía Ramírez", priority: "alta",
        checklist: [{ title: "Ticket #114", done: false }, { title: "Ticket #118", done: false }] },
    ] },
    { name: "Hecho", tasks: [
      { title: "Cerrar el reporte semanal", responsible_name: "Marcela Ruiz", priority: "media",
        checklist: [{ title: "Enviar a Dirección", done: true }] },
    ] },
  ] },
];

interactionRouter.post("/campaigns/:id/board-templates/seed-defaults", requireAdmin, async (req, res) => {
  const c = await query(`SELECT id FROM campaigns WHERE id = $1`, [req.params.id]);
  if (c.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  const created = [];
  for (const tpl of DEFAULT_BOARD_TEMPLATES) {
    const existing = await query(`SELECT id FROM board_templates WHERE campaign_id = $1 AND name = $2`, [req.params.id, tpl.name]);
    if (existing.rows.length > 0) { created.push({ id: existing.rows[0].id, name: tpl.name, skipped: true }); continue; }
    const seed = [];
    for (const col of tpl.columns) {
      const tasks = [];
      for (const t of col.tasks) {
        const responsible_contact_id = t.responsible_name ? await ensureContact(req.params.id, t.responsible_name) : null;
        tasks.push({ title: t.title, responsible_contact_id, priority: t.priority, checklist: t.checklist });
      }
      seed.push({ name: col.name, tasks });
    }
    const err = validateBoardSeed(seed);
    if (err) { created.push({ name: tpl.name, error: err }); continue; } // no debería pasar -- la semilla de arriba ya respeta la forma esperada
    const r = await query(
      `INSERT INTO board_templates (campaign_id, name, seed) VALUES ($1,$2,$3::jsonb) RETURNING id, name`,
      [req.params.id, tpl.name, JSON.stringify(seed)]
    );
    created.push(r.rows[0]);
  }
  res.status(201).json({ board_templates: created, total: created.length });
});

// ---------------------------------------------------------------------------
// Guiones de chat (conversación ambiente + puntos de inyección de ataque).
function validateChatScript(script) {
  if (!Array.isArray(script)) return "script debe ser un arreglo de pasos";
  for (const step of script) {
    if (!step || (step.type !== "scripted" && step.type !== "attack")) {
      return "cada paso necesita type: 'scripted' | 'attack'";
    }
    if (step.type === "scripted" && typeof step.body !== "string") return "un paso 'scripted' necesita 'body'";
    if (step.type === "attack" && typeof step.template_id !== "string") return "un paso 'attack' necesita 'template_id'";
  }
  return null;
}

interactionRouter.post("/campaigns/:id/chat-scripts", requireAdmin, async (req, res) => {
  const { name, script } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "Falta 'name'" });
  const err = validateChatScript(script ?? []);
  if (err) return res.status(400).json({ error: err });
  const c = await query(`SELECT id FROM campaigns WHERE id = $1`, [req.params.id]);
  if (c.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  const r = await query(
    `INSERT INTO chat_script_templates (campaign_id, name, script) VALUES ($1, $2, $3::jsonb) RETURNING *`,
    [req.params.id, name, JSON.stringify(script ?? [])]
  );
  res.status(201).json({ chat_script: r.rows[0] });
});

interactionRouter.get("/campaigns/:id/chat-scripts", requireAdmin, async (req, res) => {
  const r = await query(`SELECT * FROM chat_script_templates WHERE campaign_id = $1 ORDER BY created_at`, [req.params.id]);
  res.json({ chat_scripts: r.rows });
});

// Dos guiones de ejemplo, cada uno con un mensaje ambiente y un ataque real
// insertado -- referencian por NOMBRE dos de las plantillas "chat directo"
// que ya vienen en la biblioteca estándar de mensajes (paso 3, ver
// templates.js). Si esa plantilla todavía no existe (el admin no corrió
// "Crear biblioteca estándar" en el paso 3), se informa cuál falta en vez de
// fallar en silencio o crear un guion incompleto.
const DEFAULT_CHAT_SCRIPTS = [
  { name: "Guion — Urgencia por chat", steps: [
    { type: "scripted", sender_name: "Andrés Gómez", body: "Hola, ¿cómo vas con lo de esta semana?" },
    { type: "attack", sender_name: "Andrés Gómez", template_name: "Urgencia — Chat: se cae la demo si no confirmas ya" },
  ] },
  { name: "Guion — Escasez por chat", steps: [
    { type: "scripted", sender_name: "Laura Méndez", body: "Oye, ¿tienes un minuto?" },
    { type: "attack", sender_name: "Laura Méndez", template_name: "Escasez — Chat: quedan 2 lugares en la mesa de trabajo" },
  ] },
];

interactionRouter.post("/campaigns/:id/chat-scripts/seed-defaults", requireAdmin, async (req, res) => {
  const c = await query(`SELECT id FROM campaigns WHERE id = $1`, [req.params.id]);
  if (c.rows.length === 0) return res.status(404).json({ error: "Campaña no encontrada" });
  const created = [];
  for (const tpl of DEFAULT_CHAT_SCRIPTS) {
    const existing = await query(`SELECT id FROM chat_script_templates WHERE campaign_id = $1 AND name = $2`, [req.params.id, tpl.name]);
    if (existing.rows.length > 0) { created.push({ id: existing.rows[0].id, name: tpl.name, skipped: true }); continue; }
    const script = [];
    let missingTemplate = null;
    for (const step of tpl.steps) {
      const sender_contact_id = step.sender_name ? await ensureContact(req.params.id, step.sender_name) : undefined;
      if (step.type === "scripted") {
        script.push({ type: "scripted", sender_contact_id, body: step.body });
      } else {
        const t = await query(`SELECT id FROM templates WHERE name = $1 AND is_attack = TRUE`, [step.template_name]);
        if (t.rows.length === 0) { missingTemplate = step.template_name; break; }
        script.push({ type: "attack", sender_contact_id, template_id: t.rows[0].id });
      }
    }
    if (missingTemplate) {
      created.push({ name: tpl.name, error: `Falta la plantilla "${missingTemplate}" — crea primero la biblioteca estándar en el paso 3.` });
      continue;
    }
    const r = await query(
      `INSERT INTO chat_script_templates (campaign_id, name, script) VALUES ($1,$2,$3::jsonb) RETURNING id, name`,
      [req.params.id, tpl.name, JSON.stringify(script)]
    );
    created.push(r.rows[0]);
  }
  res.status(201).json({ chat_scripts: created, total: created.length });
});

// Qué guion de chat / plantilla de tablero usar por defecto para una
// campaña, para no tener que pasar el id a mano al instanciar (ver
// tracking.js). Se guarda como la más reciente por simplicidad: una
// campaña normalmente tiene un solo guion/tablero base.
interactionRouter.get("/campaigns/:id/chat-scripts/default", requireAdmin, async (req, res) => {
  const r = await query(
    `SELECT * FROM chat_script_templates WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [req.params.id]
  );
  res.json({ chat_script: r.rows[0] ?? null });
});

// ---------------------------------------------------------------------------
// Árbol de respuestas: qué acciones rápidas ofrece un template, y a qué
// template lleva cada una.
interactionRouter.post("/templates/:id/branches", requireAdmin, async (req, res) => {
  const { action_key, action_label, to_template_id } = req.body ?? {};
  if (!action_key || !action_label || !to_template_id) {
    return res.status(400).json({ error: "Campos requeridos: action_key, action_label, to_template_id" });
  }
  const from = await query(`SELECT id FROM templates WHERE id = $1`, [req.params.id]);
  if (from.rows.length === 0) return res.status(404).json({ error: "Plantilla de origen no encontrada" });
  const to = await query(`SELECT id FROM templates WHERE id = $1`, [to_template_id]);
  if (to.rows.length === 0) return res.status(404).json({ error: "Plantilla de destino no encontrada" });
  const r = await query(
    `INSERT INTO message_branches (from_template_id, action_key, action_label, to_template_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (from_template_id, action_key) DO UPDATE SET action_label = EXCLUDED.action_label, to_template_id = EXCLUDED.to_template_id
     RETURNING *`,
    [req.params.id, action_key, action_label, to_template_id]
  );
  res.status(201).json({ branch: r.rows[0] });
});

interactionRouter.get("/templates/:id/branches", requireAdmin, async (req, res) => {
  const r = await query(`SELECT * FROM message_branches WHERE from_template_id = $1 ORDER BY created_at`, [req.params.id]);
  res.json({ branches: r.rows });
});

interactionRouter.delete("/branches/:id", requireAdmin, async (req, res) => {
  const r = await query(`DELETE FROM message_branches WHERE id = $1 RETURNING id`, [req.params.id]);
  if (r.rows.length === 0) return res.status(404).json({ error: "Rama no encontrada" });
  res.json({ deleted: r.rows[0].id });
});

// ---------------------------------------------------------------------------
// Credenciales de práctica por participante (NO son credenciales reales de
// nadie — ver migración 010). Se asignan sobre filas de participant_campaign
// ya existentes (creadas con /campaigns/:id/generate-tokens).
interactionRouter.post("/campaigns/:id/practice-credentials", requireAdmin, async (req, res) => {
  const { assignments } = req.body ?? {};
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return res.status(400).json({ error: "Falta 'assignments': [{ participant_campaign_id, username, password }, ...]" });
  }
  let updated = 0;
  for (const a of assignments) {
    if (!a?.participant_campaign_id || !a?.username || !a?.password) continue;
    const r = await query(
      `UPDATE participant_campaign SET practice_username = $1, practice_password = $2
       WHERE id = $3 AND campaign_id = $4 RETURNING id`,
      [a.username, a.password, a.participant_campaign_id, req.params.id]
    );
    if (r.rows.length > 0) updated++;
  }
  res.json({ updated });
});
