-- ============================================================================
-- Migración 001 — App señuelo "TaskFlow" + asignación por semilla
-- Aplica sobre una base creada con la versión anterior de schema.sql.
-- Para bases nuevas NO hace falta: schema.sql ya incluye todo esto.
-- Ejecutar:  psql "$DATABASE_URL" -f db/migrations/001_taskflow_decoy.sql
-- ============================================================================

BEGIN;

-- Nuevos tipos enum -----------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE landing_kind AS ENUM ('form', 'permiso');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Nuevo valor de event_type (ADD VALUE no admite IF NOT EXISTS en toda versión;
-- se envuelve para ser idempotente).
DO $$ BEGIN
  ALTER TYPE event_type ADD VALUE 'permiso_concedido';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- templates -----------------------------------------------------------------
ALTER TABLE templates ADD COLUMN IF NOT EXISTS sender_label   TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS message_body   TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS cta_label      TEXT NOT NULL DEFAULT 'Abrir';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS landing_kind   landing_kind NOT NULL DEFAULT 'form';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS landing_config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE templates ALTER COLUMN body_ref DROP NOT NULL;
ALTER TABLE templates ALTER COLUMN channel SET DEFAULT 'web';

-- campaigns ---------------------------------------------------------------
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS seed TEXT NOT NULL DEFAULT substr(md5(random()::text), 1, 12);
ALTER TABLE campaigns ALTER COLUMN template_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS campaign_templates (
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  template_id  UUID NOT NULL REFERENCES templates(id),
  PRIMARY KEY (campaign_id, template_id)
);

-- participant_campaign --------------------------------------------------------
ALTER TABLE participant_campaign ADD COLUMN IF NOT EXISTS assigned_template_id   UUID REFERENCES templates(id);
ALTER TABLE participant_campaign ADD COLUMN IF NOT EXISTS session_started_at     TIMESTAMPTZ;
ALTER TABLE participant_campaign ADD COLUMN IF NOT EXISTS usability_interactions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE participant_campaign ADD COLUMN IF NOT EXISTS finished_at            TIMESTAMPTZ;

-- events --------------------------------------------------------------------
ALTER TABLE events ADD COLUMN IF NOT EXISTS detail TEXT;

-- post_session_survey -------------------------------------------------------
ALTER TABLE post_session_survey ADD COLUMN IF NOT EXISTS vector_specific_answer TEXT;
ALTER TABLE post_session_survey ADD COLUMN IF NOT EXISTS free_comment           TEXT;

COMMIT;

-- Las vistas se recrean fuera de la transacción anterior para poder usar
-- CREATE OR REPLACE aunque cambie la lista de columnas.
DROP VIEW IF EXISTS v_metrics_by_role_vector CASCADE;
DROP VIEW IF EXISTS v_fall_reason_breakdown CASCADE;
DROP VIEW IF EXISTS v_falls_by_team CASCADE;
DROP VIEW IF EXISTS v_team_summary CASCADE;

CREATE VIEW v_metrics_by_role_vector AS
SELECT
  p.role,
  t.vector,
  COUNT(DISTINCT pc.id)                                    AS total_expuestos,
  COUNT(DISTINCT e_open.participant_campaign_id)           AS total_abiertos,
  COUNT(DISTINCT e_click.participant_campaign_id)          AS total_clics,
  COUNT(DISTINCT e_submit.participant_campaign_id)         AS total_intentos_envio,
  COUNT(DISTINCT e_grant.participant_campaign_id)          AS total_permisos_concedidos,
  COUNT(DISTINCT e_report.participant_campaign_id)         AS total_reportes,
  ROUND(COUNT(DISTINCT e_click.participant_campaign_id)::numeric
        / NULLIF(COUNT(DISTINCT pc.id), 0) * 100, 2)       AS ctr_pct,
  ROUND(COUNT(DISTINCT COALESCE(e_submit.participant_campaign_id, e_grant.participant_campaign_id))::numeric
        / NULLIF(COUNT(DISTINCT pc.id), 0) * 100, 2)       AS conversion_pct,
  ROUND(AVG(e_click.reaction_time_ms), 0)                  AS tiempo_reaccion_promedio_ms
FROM participant_campaign pc
JOIN participants p  ON p.id = pc.participant_id
JOIN campaigns c     ON c.id = pc.campaign_id
JOIN templates t     ON t.id = COALESCE(pc.assigned_template_id, c.template_id)
LEFT JOIN events e_open   ON e_open.participant_campaign_id = pc.id   AND e_open.event_type = 'abierto'
LEFT JOIN events e_click  ON e_click.participant_campaign_id = pc.id  AND e_click.event_type = 'clic'
LEFT JOIN events e_submit ON e_submit.participant_campaign_id = pc.id AND e_submit.event_type = 'intento_envio'
LEFT JOIN events e_grant  ON e_grant.participant_campaign_id = pc.id  AND e_grant.event_type = 'permiso_concedido'
LEFT JOIN events e_report ON e_report.participant_campaign_id = pc.id AND e_report.event_type = 'reportado'
GROUP BY p.role, t.vector;

CREATE VIEW v_fall_reason_breakdown AS
SELECT p.role, t.vector, s.fall_reason, COUNT(*) AS total
FROM post_session_survey s
JOIN participant_campaign pc ON pc.id = s.participant_campaign_id
JOIN participants p ON p.id = pc.participant_id
JOIN campaigns c ON c.id = pc.campaign_id
JOIN templates t ON t.id = COALESCE(pc.assigned_template_id, c.template_id)
WHERE s.fell_for_attack = TRUE
GROUP BY p.role, t.vector, s.fall_reason;

CREATE VIEW v_falls_by_team AS
SELECT p.team_label, t.vector AS escenario, s.fall_reason AS motivo,
       COUNT(*) AS participantes_caidos
FROM post_session_survey s
JOIN participant_campaign pc ON pc.id = s.participant_campaign_id
JOIN participants p ON p.id = pc.participant_id
JOIN campaigns c ON c.id = pc.campaign_id
JOIN templates t ON t.id = COALESCE(pc.assigned_template_id, c.template_id)
WHERE s.fell_for_attack = TRUE
GROUP BY p.team_label, t.vector, s.fall_reason
ORDER BY p.team_label, participantes_caidos DESC;

CREATE VIEW v_team_summary AS
SELECT
  p.team_label,
  COUNT(DISTINCT pc.id)                                                    AS total_expuestos,
  COUNT(DISTINCT CASE WHEN s.fell_for_attack THEN pc.id END)               AS total_caidos,
  ROUND(COUNT(DISTINCT CASE WHEN s.fell_for_attack THEN pc.id END)::numeric
        / NULLIF(COUNT(DISTINCT pc.id), 0) * 100, 1)                       AS tasa_caida_pct
FROM participant_campaign pc
JOIN participants p ON p.id = pc.participant_id
LEFT JOIN post_session_survey s ON s.participant_campaign_id = pc.id
GROUP BY p.team_label
ORDER BY p.team_label;
