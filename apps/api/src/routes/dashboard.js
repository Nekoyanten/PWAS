import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

export const dashboardRouter = Router();

// Todo lo que devuelve este router es AGREGADO: nunca una fila por
// participante identificable. Ver v_falls_by_team / v_team_summary en schema.sql.

dashboardRouter.get("/by-team", requireAdmin, async (req, res) => {
  const summary = await query(`SELECT * FROM v_team_summary`);
  const falls = await query(`SELECT * FROM v_falls_by_team`);
  res.json({ resumen_por_equipo: summary.rows, caidas_detalle: falls.rows });
});

dashboardRouter.get("/by-role-vector", requireAdmin, async (req, res) => {
  const result = await query(`SELECT * FROM v_metrics_by_role_vector`);
  res.json({ metrics: result.rows });
});

dashboardRouter.get("/fall-reasons", requireAdmin, async (req, res) => {
  const result = await query(`SELECT * FROM v_fall_reason_breakdown`);
  res.json({ reasons: result.rows });
});

// Resumen ejecutivo de una sola llamada — pensado para poblar el dashboard
// de un vistazo (Objetivo 4).
dashboardRouter.get("/overview", requireAdmin, async (req, res) => {
  const [totals, byTeam, byRoleVector, reasons] = await Promise.all([
    query(`
      SELECT
        COUNT(DISTINCT pc.id) AS total_expuestos,
        COUNT(DISTINCT CASE WHEN s.fell_for_attack THEN pc.id END) AS total_caidos,
        ROUND(COUNT(DISTINCT CASE WHEN s.fell_for_attack THEN pc.id END)::numeric
              / NULLIF(COUNT(DISTINCT pc.id),0) * 100, 1) AS tasa_caida_pct,
        ROUND(AVG(e.reaction_time_ms) FILTER (WHERE e.event_type = 'clic'), 0) AS tiempo_reaccion_promedio_ms
      FROM participant_campaign pc
      LEFT JOIN post_session_survey s ON s.participant_campaign_id = pc.id
      LEFT JOIN events e ON e.participant_campaign_id = pc.id
    `),
    query(`SELECT * FROM v_team_summary`),
    query(`SELECT * FROM v_metrics_by_role_vector`),
    query(`SELECT * FROM v_fall_reason_breakdown`),
  ]);

  res.json({
    totales: totals.rows[0],
    por_equipo: byTeam.rows,
    por_rol_y_escenario: byRoleVector.rows,
    motivos_de_caida: reasons.rows,
  });
});
