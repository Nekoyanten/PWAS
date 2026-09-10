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

// ---------------------------------------------------------------------------
// Plantillas de tablero (semilla de columnas + tareas a clonar).
function validateBoardSeed(seed) {
  if (!Array.isArray(seed)) return "seed debe ser un arreglo de columnas";
  for (const col of seed) {
    if (!col || typeof col.name !== "string" || !col.name.trim()) return "cada columna necesita 'name'";
    if (col.tasks !== undefined && !Array.isArray(col.tasks)) return "'tasks' debe ser un arreglo";
    for (const t of col.tasks ?? []) {
      if (!t || typeof t.title !== "string" || !t.title.trim()) return "cada tarea necesita 'title'";
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
