import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

export const participantsRouter = Router();

const VALID_ROLES = ["estudiante", "profesor", "directivo"];
const VALID_GROUPS = ["control", "experimental"];

// Importa participantes ya seudonimizados. El backend NUNCA calcula el hash
// a partir de un dato real: espera recibir external_hash ya generado fuera
// de este sistema (ver README, sección "Cómo generar los hashes").
participantsRouter.post("/import", requireAdmin, async (req, res) => {
  const rows = req.body?.participants;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "Se espera { participants: [ { external_hash, role, team_label?, group_assignment?, consent_given? } ] }" });
  }

  const inserted = [];
  const errors = [];
  for (const [i, r] of rows.entries()) {
    if (!r.external_hash || typeof r.external_hash !== "string") {
      errors.push({ index: i, error: "external_hash requerido" });
      continue;
    }
    if (!VALID_ROLES.includes(r.role)) {
      errors.push({ index: i, error: `role inválido: ${r.role}` });
      continue;
    }
    if (r.group_assignment && !VALID_GROUPS.includes(r.group_assignment)) {
      errors.push({ index: i, error: `group_assignment inválido: ${r.group_assignment}` });
      continue;
    }
    try {
      const result = await query(
        `INSERT INTO participants (external_hash, role, team_label, group_assignment, consent_given, consent_timestamp)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 THEN now() ELSE NULL END)
         ON CONFLICT (external_hash) DO UPDATE SET
           team_label = EXCLUDED.team_label,
           group_assignment = EXCLUDED.group_assignment
         RETURNING id, external_hash, role, team_label, group_assignment`,
        [r.external_hash, r.role, r.team_label ?? null, r.group_assignment ?? null, !!r.consent_given]
      );
      inserted.push(result.rows[0]);
    } catch (err) {
      errors.push({ index: i, error: err.message });
    }
  }

  res.status(errors.length && !inserted.length ? 400 : 201).json({
    imported: inserted.length,
    failed: errors.length,
    errors,
    participants: inserted,
  });
});

// Lista operativa (para asignar campañas) — expone solo id interno, hash
// seudónimo, rol, equipo y grupo. Nunca nombre/correo/documento porque esas
// columnas no existen en el esquema.
participantsRouter.get("/", requireAdmin, async (req, res) => {
  const result = await query(
    `SELECT id, external_hash, role, team_label, group_assignment, consent_given, created_at
     FROM participants ORDER BY created_at DESC LIMIT 500`
  );
  res.json({ participants: result.rows });
});
