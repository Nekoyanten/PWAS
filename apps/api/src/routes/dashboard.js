import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { recomputeSessionFeatures } from "../lib/behaviorFeatures.js";
import { recomputeFacialSessionFeatures } from "../lib/facialFeatures.js";

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

// Resumen de la captura conductual (Tabla 1 §8.2.1, fila 1), agregado por
// `phase` — para responder de un vistazo "¿de verdad estamos midiendo esto?"
// sin tener que abrir el CSV crudo de /api/export/behavior-events. NUNCA una
// fila por participante: solo conteos y promedios por fase.
//
// `duracion_prom_seg` = promedio de (última muestra recibida − primera) por
// sesión de esa fase: un proxy razonable de "cuánto tiempo pasó ahí" (p.ej.
// en 'landing' o 'calibration', que corresponden a una sola pantalla), pero
// en 'app' abarca toda la navegación, no una tarea puntual — para tiempos
// por ataque específico, ver `tiempo_reaccion_ms` en /api/dashboard/overview.
//
// Dos CTEs por separado (sesiones y eventos) en vez de un solo JOIN+GROUP BY:
// unir behavior_sessions con behavior_events antes de agregar duplicaría cada
// sesión una vez por cada una de sus muestras, e inflaría sesiones/duración
// (bug real, encontrado y corregido en revisión antes de enviar esto).
dashboardRouter.get("/behavior-summary", requireAdmin, async (req, res) => {
  const params = [];
  let where = "";
  if (req.query.campaign_id) {
    params.push(req.query.campaign_id);
    where = `WHERE pc.campaign_id = $${params.length}`;
  }
  const result = await query(
    `WITH sess AS (
       SELECT bs.phase, bs.id, bs.participant_campaign_id,
              EXTRACT(EPOCH FROM (bs.last_flush_at - bs.started_at)) AS duracion_seg
       FROM behavior_sessions bs
       JOIN participant_campaign pc ON pc.id = bs.participant_campaign_id
       ${where}
     ),
     sess_agg AS (
       SELECT phase, COUNT(*)::int AS sesiones, COUNT(DISTINCT participant_campaign_id)::int AS participantes,
              ROUND(AVG(duracion_seg)::numeric, 1) AS duracion_prom_seg
       FROM sess GROUP BY phase
     ),
     events_agg AS (
       SELECT sess.phase,
              COUNT(*) AS muestras_totales,
              COUNT(*) FILTER (WHERE be.event_type = 'mousemove')                        AS mousemove,
              COUNT(*) FILTER (WHERE be.event_type IN ('click','mousedown','mouseup'))    AS clics,
              COUNT(*) FILTER (WHERE be.event_type IN ('keydown','keyup'))                AS teclas
       FROM sess JOIN behavior_events be ON be.behavior_session_id = sess.id
       GROUP BY sess.phase
     )
     SELECT sa.phase, sa.sesiones, sa.participantes, sa.duracion_prom_seg,
            COALESCE(ea.muestras_totales, 0)::int AS muestras_totales,
            COALESCE(ea.mousemove, 0)::int        AS mousemove,
            COALESCE(ea.clics, 0)::int             AS clics,
            COALESCE(ea.teclas, 0)::int            AS teclas
     FROM sess_agg sa
     LEFT JOIN events_agg ea ON ea.phase = sa.phase
     ORDER BY sa.phase`,
    params
  );
  res.json({ por_fase: result.rows });
});

// Resumen del motor de decisión por riesgo (migración 007, TG §8.2.5),
// MODO SOMBRA -- agregado por group_assignment, para comparar de un vistazo
// qué tan seguido el puntaje de riesgo HABRÍA mostrado la intervención
// (risk_would_trigger, calculado por ml/ + apps/api/src/lib/riskScore.js)
// contra lo que de verdad se mostró con el sorteo de probabilidad
// (jolting_roll + evento 'intervencion_mostrada'). Es solo para análisis:
// no cambia nada del flujo del participante, y las etiquetas con las que se
// entrenó el modelo siguen siendo sintéticas (ver
// docs/2026-09-07_motor-decision-riesgo.md).
dashboardRouter.get("/risk-summary", requireAdmin, async (req, res) => {
  const params = [];
  let campaignFilter = "";
  if (req.query.campaign_id) {
    params.push(req.query.campaign_id);
    campaignFilter = `AND pc.campaign_id = $${params.length}`;
  }
  const result = await query(
    `SELECT COALESCE(p.group_assignment::text, 'sin_grupo') AS grupo,
            COUNT(*)::int AS ataques_totales,
            COUNT(d.risk_score)::int AS puntuados,
            COUNT(*) FILTER (WHERE d.risk_score_error IS NOT NULL)::int AS con_error,
            ROUND(AVG(d.risk_score)::numeric, 4) AS riesgo_promedio,
            COUNT(*) FILTER (WHERE d.risk_would_trigger)::int AS gate_sombra_habria_mostrado,
            COUNT(DISTINCT ev.delivery_id)::int AS intervencion_mostrada_real
     FROM deliveries d
     JOIN messages m ON m.id = d.message_id
     JOIN participant_campaign pc ON pc.id = d.participant_campaign_id
     JOIN participants p ON p.id = pc.participant_id
     LEFT JOIN events ev ON ev.delivery_id = d.id AND ev.event_type = 'intervencion_mostrada'
     WHERE m.is_attack ${campaignFilter}
     GROUP BY p.group_assignment
     ORDER BY grupo`,
    params
  );
  res.json({ por_grupo: result.rows });
});

// Etiquetado fino (Tabla 1 §8.2.1, módulo 7, migración 008): recalcula y
// persiste en `behavior_session_features` las features REALES por sesión
// (AUC/SE/MD de mouse, latencias de tecleo, z-scores contra calibración) --
// ver apps/api/src/lib/behaviorFeatures.js para el porqué de que esto sea
// un job por lote (POST, a pedido) y no algo automático en cada evento.
// Body opcional {campaign_id}: sin él, recalcula TODAS las sesiones de la
// base (igual alcance que una corrida de `python3 -m src.evaluate`); con
// él, solo las de esa campaña -- útil para no esperar por sesiones de otras
// campañas mientras se analiza una en curso.
dashboardRouter.post("/recompute-features", requireAdmin, async (req, res) => {
  try {
    const campaignId = typeof req.body?.campaign_id === "string" ? req.body.campaign_id : undefined;
    const result = await recomputeSessionFeatures({ campaignId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "no se pudieron recalcular las features", detail: err.message });
  }
});

// Resumen de `behavior_session_features`, agregado por fase -- para ver de
// un vistazo si el etiquetado fino está al día (cuántas sesiones tienen
// features calculadas frente al total en `behavior_sessions`) y un promedio
// simple de las features más leídas, sin exponer una fila por participante.
dashboardRouter.get("/features-summary", requireAdmin, async (req, res) => {
  const params = [];
  let where = "";
  if (req.query.campaign_id) {
    params.push(req.query.campaign_id);
    where = `WHERE pc.campaign_id = $${params.length}`;
  }
  const result = await query(
    `WITH sess AS (
       SELECT bs.id, bs.phase, bs.participant_campaign_id
       FROM behavior_sessions bs
       JOIN participant_campaign pc ON pc.id = bs.participant_campaign_id
       ${where}
     )
     SELECT sess.phase,
            COUNT(*)::int AS sesiones_totales,
            COUNT(f.session_id)::int AS con_features,
            ROUND(AVG(f.mouse_auc)::numeric, 6)              AS mouse_auc_promedio,
            ROUND(AVG(f.mouse_mean_velocity)::numeric, 6)    AS mouse_velocidad_promedio,
            ROUND(AVG(f.key_mean_dwell_ms)::numeric, 2)      AS tecleo_dwell_promedio_ms,
            ROUND(AVG(f.key_mean_flight_ms)::numeric, 2)     AS tecleo_flight_promedio_ms,
            COUNT(*) FILTER (WHERE f.baseline_z_source = 'personal')::int    AS con_linea_base_personal,
            COUNT(*) FILTER (WHERE f.baseline_z_source = 'poblacional')::int AS con_linea_base_poblacional,
            MAX(f.computed_at) AS ultimo_calculo
     FROM sess
     LEFT JOIN behavior_session_features f ON f.session_id = sess.id
     GROUP BY sess.phase
     ORDER BY sess.phase`,
    params
  );
  res.json({ por_fase: result.rows });
});

// Captura biométrica facial (migración 015) -- mismos dos endpoints que la
// captura conductual (recompute a pedido + resumen agregado por fase), por
// las mismas razones: no hay señal de "sesión cerrada" y la línea base de
// calibración depende del conjunto completo. Ver facialFeatures.js.
dashboardRouter.post("/recompute-facial-features", requireAdmin, async (req, res) => {
  try {
    const campaignId = typeof req.body?.campaign_id === "string" ? req.body.campaign_id : undefined;
    const result = await recomputeFacialSessionFeatures({ campaignId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "no se pudieron recalcular las features faciales", detail: err.message });
  }
});

dashboardRouter.get("/facial-features-summary", requireAdmin, async (req, res) => {
  const params = [];
  let where = "";
  if (req.query.campaign_id) {
    params.push(req.query.campaign_id);
    where = `WHERE pc.campaign_id = $${params.length}`;
  }
  const result = await query(
    `WITH sess AS (
       SELECT fs.id, fs.phase, fs.participant_campaign_id
       FROM facial_sessions fs
       JOIN participant_campaign pc ON pc.id = fs.participant_campaign_id
       ${where}
     )
     SELECT sess.phase,
            COUNT(*)::int AS sesiones_totales,
            COUNT(f.session_id)::int AS con_features,
            ROUND(AVG(f.face_detected_ratio)::numeric, 3)   AS deteccion_rostro_promedio,
            ROUND(AVG(f.blink_rate_per_min)::numeric, 2)    AS parpadeos_por_min_promedio,
            ROUND(AVG(f.eye_openness_mean)::numeric, 3)     AS apertura_ocular_promedio,
            ROUND(AVG(f.gaze_dispersion_x)::numeric, 3)     AS dispersion_mirada_x_promedio,
            ROUND(AVG(f.brow_tension_mean)::numeric, 3)     AS tension_ceja_promedio,
            ROUND(AVG(f.mouth_tension_mean)::numeric, 3)    AS tension_boca_promedio,
            COUNT(*) FILTER (WHERE f.baseline_z_source = 'personal')::int    AS con_linea_base_personal,
            COUNT(*) FILTER (WHERE f.baseline_z_source = 'poblacional')::int AS con_linea_base_poblacional,
            MAX(f.computed_at) AS ultimo_calculo
     FROM sess
     LEFT JOIN facial_session_features f ON f.session_id = sess.id
     GROUP BY sess.phase
     ORDER BY sess.phase`,
    params
  );
  res.json({ por_fase: result.rows });
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
  const [totals, byTeam, byRoleVector, reasons, funnel, byTecnica, byRol, byCanal, percepcion] = await Promise.all([
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
              / NULLIF(COUNT(DISTINCT s.participant_campaign_id),0) * 100, 1) AS tasa_reconocimiento_pct,
        -- N del sub-estudio exploratorio de captura facial (TG §8.2.9/§9.2/§9.6):
        -- un SUBCONJUNTO de total_expuestos (el núcleo de Fase 1, mouse/teclado),
        -- nunca un universo aparte -- así el panel deja tan visible como el texto
        -- de la tesis que declinar la cámara no saca a nadie del piloto central.
        COUNT(DISTINCT CASE WHEN p.camera_consent_given THEN pc.id END) AS total_consentimiento_camara
      FROM participant_campaign pc
      JOIN participants p ON p.id = pc.participant_id
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
    // por_canal (migración 013/admin ampliado): mismo desglose que
    // por_tecnica/por_rol pero por CÓMO se entregó el ataque -- correo
    // (bandeja), tarea asignada, o dentro del chat de equipo (m.kind='chat',
    // ver lib/chat.js). Pedido explícito del equipo para poder "contar" los
    // ataques por chat desde el panel admin, no solo poder crearlos.
    query(attackMetricsSQL("m.kind")),
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
    por_canal: byCanal.rows,
    percepcion: percepcion.rows[0],
  });
});
