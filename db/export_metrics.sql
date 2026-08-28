-- ============================================================================
-- Export de métricas para las gráficas de la tesis (Objetivo 3)
-- Ejecutar con: psql -h <host> -U <user> -d paws_campaign -f export_metrics.sql
-- ============================================================================

-- 1) CSV — comparativa CTR/conversión por rol y por vector de ataque
\copy (SELECT * FROM v_metrics_by_role_vector ORDER BY role, vector) TO 'export_metrics_by_role_vector.csv' WITH CSV HEADER;

-- 2) CSV — desglose de motivo de caída por rol y vector
\copy (SELECT * FROM v_fall_reason_breakdown ORDER BY role, vector, fall_reason) TO 'export_fall_reason_breakdown.csv' WITH CSV HEADER;

-- 3) JSON — mismo contenido que (1), listo para alimentar un gráfico de barras (Chart.js/D3) sin transformación adicional
\copy (SELECT json_agg(row_to_json(v)) AS data FROM v_metrics_by_role_vector v) TO 'export_metrics_by_role_vector.json';

-- 4) JSON — eventos crudos con timestamps (para el reporte de resultados y estudios de ablación temporal)
\copy (
  SELECT
    p.role,
    p.group_assignment,
    t.vector,
    e.event_type,
    e.occurred_at,
    e.reaction_time_ms
  FROM events e
  JOIN participant_campaign pc ON pc.id = e.participant_campaign_id
  JOIN participants p ON p.id = pc.participant_id
  JOIN campaigns c ON c.id = pc.campaign_id
  JOIN templates t ON t.id = c.template_id
  ORDER BY e.occurred_at
) TO 'export_events_raw.csv' WITH CSV HEADER;
