import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

export const participantsRouter = Router();

const VALID_ROLES = ["estudiante", "profesor", "directivo"];
const VALID_GROUPS = ["control", "experimental"];

// Importa participantes ya seudonimizados. El backend NUNCA calcula el hash
// a partir de un dato real: espera recibir external_hash ya generado fuera
// de este sistema (ver README, sección "Cómo generar los hashes").
async function importParticipants(req, res) {
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
}

participantsRouter.post("/import", requireAdmin, importParticipants);

// Importación por CSV. Cabecera obligatoria; columnas reconocidas:
// external_hash, role, team_label, group_assignment, consent_given.
// Acepta el CSV en el body como texto (Content-Type: text/csv o text/plain)
// o como { csv: "..." } en JSON.
participantsRouter.post("/import-csv", requireAdmin, async (req, res) => {
  const raw = typeof req.body === "string" ? req.body : req.body?.csv;
  if (!raw || typeof raw !== "string") {
    return res.status(400).json({ error: "Envía el CSV como texto en el body o como { csv: \"...\" }" });
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return res.status(400).json({ error: "El CSV necesita una cabecera y al menos una fila" });

  // Divide una línea CSV respetando comillas: un campo entre comillas puede
  // contener comas (p.ej. un team_label como "Sistemas, turno tarde") y ""
  // dentro de un campo entrecomillado es una comilla literal escapada. Un
  // split(",") ingenuo cortaba esos campos en el punto equivocado.
  const split = (line) => {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
        } else {
          cur += c;
        }
      } else if (c === '"' && cur === "") {
        inQuotes = true;
      } else if (c === ",") {
        out.push(cur.trim());
        cur = "";
      } else {
        cur += c;
      }
    }
    out.push(cur.trim());
    return out;
  };
  const header = split(lines[0]).map((h) => h.toLowerCase());
  const idx = (name) => header.indexOf(name);
  if (idx("external_hash") === -1 || idx("role") === -1) {
    return res.status(400).json({ error: "La cabecera debe incluir al menos external_hash y role" });
  }

  const participants = lines.slice(1).map((line) => {
    const c = split(line);
    const consent = (c[idx("consent_given")] ?? "").toLowerCase();
    return {
      external_hash: c[idx("external_hash")],
      role: c[idx("role")],
      team_label: idx("team_label") !== -1 ? c[idx("team_label")] || null : null,
      group_assignment: idx("group_assignment") !== -1 ? c[idx("group_assignment")] || null : null,
      consent_given: consent === "true" || consent === "1" || consent === "si" || consent === "sí",
    };
  });

  req.body = { participants };
  return importParticipants(req, res);
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
