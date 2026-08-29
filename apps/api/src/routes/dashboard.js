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
// Métricas sobre los deliveries de mensajes de ATAQUE, agrupadas por una sola
// dimensión (técnica o rol). Reutiliza la misma lógica que v_metrics_by_role_vector.
function attackMetricsSQL(groupCol) {
  return `
    SELECT
      ${groupCol} AS clave,
      COUNT(DISTINCT d.id)                    AS expuestos,
      COUNT(DISTINCT e_open.delivery_id)      AS abrieron,
      COUNT(DISTINCT e_click.delivery_id)     AS hicieron_clic,
      COUNT(DISTINCT COALESCE(e_submit.delivery_id, e_grant.delivery_id)) AS cayeron,
      COUNT(DISTINCT e_report.delivery_id)    AS reportaron,
      ROUND(COUNT(DISTINCT e_click.delivery_id)::numeric
            / NULLIF(COUNT(DISTINCT d.id),0) * 100, 1) AS clic_pct,
      ROUND(COUNT(DISTINCT COALESCE(e_submit.delivery_id, e_grant.delivery_id))::numeric
            / NULLIF(COUNT(DISTINCT d.id),0) * 100, 1) AS conversion_pct,
      ROUND(AVG(e_click.reaction_time_ms), 0) AS tiempo_reaccion_ms
    FROM deliveries d
    JOIN messages m ON m.id = d.message_id AND m.is_attack = TRUE
    JOIN participant_campaign pc ON pc.id = d.participant_campaign_id
    JOIN participants p ON p.id = pc.participant_id
    LEFT JOIN events e_open   ON e_open.delivery_id = d.id   AND e_open.event_type = 'abierto'
    LEFT JOIN events e_click  ON e_click.delivery_id = d.id  AND e_click.event_type = 'clic'
    LEFT JOIN events e_submit ON e_submit.delivery_id = d.id AND e_submit.event_type = 'intento_envio'
    LEFT JOIN events e_grant  ON e_grant.delivery_id = d.id  AND e_grant.event_type = 'permiso_concedido'
    LEFT JOIN events e_report ON e_report.delivery_id = d.id AND e_report.event_type = 'reportado'
    WHERE ${groupCol} IS NOT NULL
    GROUP BY ${groupCol}
    ORDER BY conversion_pct DESC NULLS LAST`;
}

dashboardRouter.get("/overview", requireAdmin, async (req, res) => {
  const [totals, byTeam, byRoleVector, reasons, funnel, byTecnica, byRol, percepcion] = await Promise.all([
    query(`
      SELECT
        COUNT(DISTINCT pc.id) AS total_expuestos,
        COUNT(DISTINCT CASE WHEN s.fell_for_attack THEN pc.id END) AS total_caidos,
        ROUND(COUNT(DISTINCT CASE WHEN s.fell_for_attack THEN pc.id END)::numeric
              / NULLIF(COUNT(DISTINCT pc.id),0) * 100, 1) AS tasa_caida_pct,
        ROUND(AVG(e.reaction_time_ms) FILTER (WHERE e.event_type = 'clic'), 0) AS tiempo_reaccion_promedio_ms,
        COUNT(DISTINCT CASE WHEN e.event_type = 'reportado' THEN pc.id END) AS total_reportes,
        COUNT(DISTINCT CASE WHEN e.event_type = 'permiso_concedido' THEN pc.id END) AS total_permisos_concedidos,
        ROUND(COUNT(DISTINCT CASE WHEN s.recognized_as_simulated THEN pc.id END)::numeric
              / NULLIF(COUNT(DISTINCT s.participant_campaign_id),0) * 100, 1) AS tasa_reconocimiento_pct
      FROM participant_campaign pc
      LEFT JOIN post_session_survey s ON s.participant_campaign_id = pc.id
      LEFT JOIN events e ON e.participant_campaign_id = pc.id
    `),
    query(`SELECT * FROM v_team_summary`),
    query(`SELECT * FROM v_metrics_by_role_vector`),
    query(`SELECT * FROM v_fall_reason_breakdown`),
    query(`
      SELECT
        COUNT(DISTINCT d.id)                    AS recibieron,
        COUNT(DISTINCT e_open.delivery_id)      AS abrieron,
        COUNT(DISTINCT e_click.delivery_id)     AS hicieron_clic,
        COUNT(DISTINCT COALESCE(e_submit.delivery_id, e_grant.delivery_id)) AS cayeron,
        COUNT(DISTINCT e_report.delivery_id)    AS reportaron
      FROM deliveries d
      JOIN messages m ON m.id = d.message_id AND m.is_attack = TRUE
      LEFT JOIN events e_open   ON e_open.delivery_id = d.id   AND e_open.event_type = 'abierto'
      LEFT JOIN events e_click  ON e_click.delivery_id = d.id  AND e_click.event_type = 'clic'
      LEFT JOIN events e_submit ON e_submit.delivery_id = d.id AND e_submit.event_type = 'intento_envio'
      LEFT JOIN events e_grant  ON e_grant.delivery_id = d.id  AND e_grant.event_type = 'permiso_concedido'
      LEFT JOIN events e_report ON e_report.delivery_id = d.id AND e_report.event_type = 'reportado'
    `),
    query(attackMetricsSQL("m.vector")),
    query(attackMetricsSQL("p.role")),
    query(`
      SELECT
        COUNT(*) AS respondieron,
        ROUND(COUNT(*) FILTER (WHERE recognized_as_simulated)::numeric / NULLIF(COUNT(*),0) * 100, 1) AS reconocieron_pct,
        ROUND(COUNT(*) FILTER (WHERE perceived_suspicion_before_action)::numeric / NULLIF(COUNT(*),0) * 100, 1) AS sospecharon_pct
      FROM post_session_survey
    `),
  ]);

  res.json({
    totales: totals.rows[0],
    por_equipo: byTeam.rows,
    por_rol_y_escenario: byRoleVector.rows,
    motivos_de_caida: reasons.rows,
    embudo: funnel.rows[0],
    por_tecnica: byTecnica.rows,
    por_rol: byRol.rows,
    percepcion: percepcion.rows[0],
  });
});
