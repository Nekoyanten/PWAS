import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

export const exportRouter = Router();

function toCsv(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(","));
  return lines.join("\n");
}

exportRouter.get("/by-role-vector.:format", requireAdmin, async (req, res) => {
  const result = await query(`SELECT * FROM v_metrics_by_role_vector ORDER BY role, vector`);
  if (req.params.format === "csv") {
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", "attachment; filename=metrics_by_role_vector.csv");
    return res.send(toCsv(result.rows));
  }
  res.json(result.rows);
});

exportRouter.get("/by-team.:format", requireAdmin, async (req, res) => {
  const result = await query(`SELECT * FROM v_falls_by_team ORDER BY team_label, participantes_caidos DESC`);
  if (req.params.format === "csv") {
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", "attachment; filename=falls_by_team.csv");
    return res.send(toCsv(result.rows));
  }
  res.json(result.rows);
});

// Exporta la captura conductual cruda (Tabla 1 §8.2.1, fila 1) para el
// pipeline de preprocesamiento/ML — que es Python y vive fuera de este repo.
// Este endpoint NO calcula ninguna feature (resampleo, AUC/SE/MD, latencias):
// solo entrega la materia prima, una fila por muestra, en el orden en que
// ocurrió, para que ese pipeline la lea con pandas/numpy y arranque desde
// ahí. Opcional ?campaign_id=<uuid> para acotar a una sola campaña.
//
// Columnas pensadas para reconstruir, por sesión (`session_id`), la serie de
// tiempo completa: rol/grupo/equipo para poder estratificar sin tener que
// volver a unir contra `participants`, y vector/is_attack cuando la muestra
// pertenece a la exposición a un mensaje concreto (fase 'message'/'landing').
exportRouter.get("/behavior-events.:format", requireAdmin, async (req, res) => {
  const params = [];
  let where = "";
  if (req.query.campaign_id) {
    params.push(req.query.campaign_id);
    where = `WHERE pc.campaign_id = $${params.length}`;
  }
  // pc.id (participant_campaign_id) es el identificador de participante que
  // se expone acá — NO p.external_hash. external_hash es el hash calculado
  // fuera de este sistema a partir del identificador real de la persona
  // (ver cabecera de db/schema.sql); pc.id es un UUID que este sistema
  // genera él mismo y no permite reconstruir a qué persona corresponde sin
  // acceso a esta base de datos. Sigue el mismo criterio que ya aplican
  // /api/campaigns/:id/coverage y /api/dashboard/overview (ver
  // tests/integration/admin.test.js: "no expone external_hash"), y basta
  // para que el pipeline de ML agrupe todas las sesiones de un mismo
  // participante sin necesitar su hash externo.
  const result = await query(
    `SELECT
       bs.id                AS session_id,
       pc.id                AS participant_campaign_id,
       bs.phase,
       bs.viewport_w, bs.viewport_h,
       p.role,
       p.group_assignment,
       p.team_label,
       m.vector             AS attack_vector,
       m.is_attack,
       be.t_ms,
       be.event_type,
       be.x, be.y, be.key_code
     FROM behavior_events be
     JOIN behavior_sessions bs      ON bs.id = be.behavior_session_id
     JOIN participant_campaign pc   ON pc.id = bs.participant_campaign_id
     JOIN participants p            ON p.id = pc.participant_id
     LEFT JOIN deliveries d         ON d.id = bs.delivery_id
     LEFT JOIN messages m           ON m.id = d.message_id
     ${where}
     ORDER BY pc.id, bs.id, be.t_ms`,
    params
  );
  if (req.params.format === "csv") {
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", "attachment; filename=behavior_events.csv");
    return res.send(toCsv(result.rows));
  }
  res.json(result.rows);
});

// Etiquetado fino (Tabla 1 §8.2.1, módulo 7, migración 008): una fila por
// SESIÓN con sus features ya calculadas (AUC/SE/MD, latencias de tecleo,
// z-scores contra calibración) -- a diferencia de behavior-events.csv de
// arriba (una fila por muestra cruda), este export no necesita abrirse en
// Python para volverse analizable: `POST /api/dashboard/recompute-features`
// deja esta tabla al día, y este endpoint solo la lee. Mismo criterio de
// privacidad que el resto de exports: pc.id (participant_campaign_id),
// nunca external_hash.
exportRouter.get("/session-features.:format", requireAdmin, async (req, res) => {
  const params = [];
  let where = "";
  if (req.query.campaign_id) {
    params.push(req.query.campaign_id);
    where = `WHERE pc.campaign_id = $${params.length}`;
  }
  const result = await query(
    `SELECT
       f.session_id, f.participant_campaign_id, f.phase,
       p.role, p.group_assignment, p.team_label,
       f.mouse_n_points, f.mouse_auc, f.mouse_se, f.mouse_md, f.mouse_path_length,
       f.mouse_straight_line_distance, f.mouse_efficiency, f.mouse_mean_velocity,
       f.mouse_std_velocity, f.mouse_mean_acceleration, f.mouse_std_acceleration,
       f.key_n_keys, f.key_mean_dwell_ms, f.key_std_dwell_ms, f.key_mean_flight_ms, f.key_std_flight_ms,
       f.mouse_mean_velocity_z, f.key_mean_dwell_ms_z, f.key_mean_flight_ms_z,
       f.baseline_z_source, f.feature_version, f.computed_at
     FROM behavior_session_features f
     JOIN participant_campaign pc ON pc.id = f.participant_campaign_id
     JOIN participants p          ON p.id = pc.participant_id
     ${where}
     ORDER BY pc.id, f.session_id`,
    params
  );
  if (req.params.format === "csv") {
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", "attachment; filename=session_features.csv");
    return res.send(toCsv(result.rows));
  }
  res.json(result.rows);
});
