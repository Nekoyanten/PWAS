-- ============================================================================
-- Migración 002 — Mensajes (correo/tarea) + deliveries + autorización simulada
-- Aplica sobre una base que ya tiene la migración 001.
-- Ejecutar:  psql "$DATABASE_URL" -f db/migrations/002_messages_deliveries.sql
-- ============================================================================

BEGIN;

DO $$ BEGIN CREATE TYPE message_kind AS ENUM ('email', 'task');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE templates ADD COLUMN IF NOT EXISTS kind      message_kind NOT NULL DEFAULT 'email';
ALTER TABLE templates ADD COLUMN IF NOT EXISTS is_attack BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS messages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  template_id    UUID REFERENCES templates(id),
  kind           message_kind NOT NULL DEFAULT 'email',
  is_attack      BOOLEAN NOT NULL DEFAULT FALSE,
  vector         attack_vector,
  sender_label   TEXT,
  subject        TEXT NOT NULL,
  body           TEXT,
  cta_label      TEXT,
  landing_kind   landing_kind,
  landing_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_campaign ON messages(campaign_id);

CREATE TABLE IF NOT EXISTS deliveries (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id              UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  participant_campaign_id UUID NOT NULL REFERENCES participant_campaign(id) ON DELETE CASCADE,
  delivered_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, participant_campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_pc ON deliveries(participant_campaign_id);

ALTER TABLE events ADD COLUMN IF NOT EXISTS delivery_id UUID REFERENCES deliveries(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_events_delivery ON events(delivery_id);

ALTER TABLE post_session_survey ADD COLUMN IF NOT EXISTS primary_message_id UUID REFERENCES messages(id);

COMMIT;

-- Vistas: ahora agregan sobre deliveries de mensajes de ataque.
DROP VIEW IF EXISTS v_metrics_by_role_vector CASCADE;
DROP VIEW IF EXISTS v_fall_reason_breakdown CASCADE;
DROP VIEW IF EXISTS v_falls_by_team CASCADE;
DROP VIEW IF EXISTS v_team_summary CASCADE;

CREATE VIEW v_metrics_by_role_vector AS
SELECT
  p.role, m.vector,
  COUNT(DISTINCT d.id)                                     AS total_expuestos,
  COUNT(DISTINCT e_open.delivery_id)                       AS total_abiertos,
  COUNT(DISTINCT e_click.delivery_id)                      AS total_clics,
  COUNT(DISTINCT e_submit.delivery_id)                     AS total_intentos_envio,
  COUNT(DISTINCT e_grant.delivery_id)                      AS total_permisos_concedidos,
  COUNT(DISTINCT e_report.delivery_id)                     AS total_reportes,
  ROUND(COUNT(DISTINCT e_click.delivery_id)::numeric
        / NULLIF(COUNT(DISTINCT d.id), 0) * 100, 2)        AS ctr_pct,
  ROUND(COUNT(DISTINCT COALESCE(e_submit.delivery_id, e_grant.delivery_id))::numeric
        / NULLIF(COUNT(DISTINCT d.id), 0) * 100, 2)        AS conversion_pct,
  ROUND(AVG(e_click.reaction_time_ms), 0)                  AS tiempo_reaccion_promedio_ms
FROM deliveries d
JOIN messages m             ON m.id = d.message_id AND m.is_attack = TRUE
JOIN participant_campaign pc ON pc.id = d.participant_campaign_id
JOIN participants p          ON p.id = pc.participant_id
LEFT JOIN events e_open   ON e_open.delivery_id = d.id   AND e_open.event_type = 'abierto'
LEFT JOIN events e_click  ON e_click.delivery_id = d.id  AND e_click.event_type = 'clic'
LEFT JOIN events e_submit ON e_submit.delivery_id = d.id AND e_submit.event_type = 'intento_envio'
LEFT JOIN events e_grant  ON e_grant.delivery_id = d.id  AND e_grant.event_type = 'permiso_concedido'
LEFT JOIN events e_report ON e_report.delivery_id = d.id AND e_report.event_type = 'reportado'
GROUP BY p.role, m.vector;

CREATE VIEW v_fall_reason_breakdown AS
SELECT p.role, m.vector, s.fall_reason, COUNT(*) AS total
FROM post_session_survey s
JOIN participant_campaign pc ON pc.id = s.participant_campaign_id
JOIN participants p          ON p.id = pc.participant_id
LEFT JOIN messages m         ON m.id = s.primary_message_id
WHERE s.fell_for_attack = TRUE
GROUP BY p.role, m.vector, s.fall_reason;

CREATE VIEW v_falls_by_team AS
SELECT p.team_label, m.vector AS escenario, s.fall_reason AS motivo, COUNT(*) AS participantes_caidos
FROM post_session_survey s
JOIN participant_campaign pc ON pc.id = s.participant_campaign_id
JOIN participants p          ON p.id = pc.participant_id
LEFT JOIN messages m         ON m.id = s.primary_message_id
WHERE s.fell_for_attack = TRUE
GROUP BY p.team_label, m.vector, s.fall_reason
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
