-- ============================================================================
-- PAWS Campaign Platform — Esquema de base de datos (PostgreSQL 14+)
-- ============================================================================
-- NOTA DE CUMPLIMIENTO (no negociable por defecto — ver PS §3.2 y TG §9.1):
--   1. Ninguna tabla contiene nombre, correo real, documento de identidad
--      ni IP completa. `external_hash` es un hash irreversible generado
--      FUERA de este sistema (nunca aquí) a partir del identificador real.
--   2. El evento 'intento_envio' registra SOLO que el formulario fue
--      enviado (booleano + timestamp). El backend debe descartar el
--      payload del formulario (valores de los campos) ANTES de que
--      llegue a cualquier código que toque esta base de datos. No existe
--      ninguna columna para contenido de credenciales, ni siquiera
--      enmascarado.
--   3. `fall_reason` es autoinformado por el propio participante durante
--      el debriefing (TG §9.5 Paso 6), no inferido automáticamente.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- para gen_random_uuid()

CREATE TYPE participant_role AS ENUM ('estudiante', 'profesor', 'directivo');
CREATE TYPE group_assignment AS ENUM ('control', 'experimental');
CREATE TYPE attack_vector AS ENUM ('autoridad', 'urgencia', 'escasez', 'prueba_social', 'curiosidad');
CREATE TYPE delivery_channel AS ENUM ('email_simulado', 'sms_simulado', 'web');
CREATE TYPE event_type AS ENUM ('entregado', 'abierto', 'clic', 'intento_envio', 'reportado');
CREATE TYPE fall_reason AS ENUM (
  'miedo_sancion', 'promesa_beneficio', 'confianza_remitente',
  'urgencia_temporal', 'prueba_social', 'curiosidad', 'no_aplica'
);
CREATE TYPE campaign_status AS ENUM ('borrador', 'programada', 'en_curso', 'finalizada', 'cancelada');

-- ----------------------------------------------------------------------------
CREATE TABLE participants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_hash       TEXT UNIQUE NOT NULL,
  role                participant_role NOT NULL,
  team_label          TEXT,             -- agrupación de laboratorio (ej. "Equipo 5", "Sala 2") — NO es un identificador personal
  group_assignment    group_assignment,
  consent_given       BOOLEAN NOT NULL DEFAULT FALSE,
  consent_timestamp   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON COLUMN participants.external_hash IS
  'Hash irreversible del identificador real, calculado fuera de este sistema. Nunca almacenar el valor original.';
COMMENT ON COLUMN participants.team_label IS
  'Etiqueta de agrupación física/lógica del laboratorio (equipo, sala, turno). Sirve para reportar "el Equipo 5 tuvo 3 caídas" sin exponer quién es cada participante.';

-- ----------------------------------------------------------------------------
CREATE TABLE templates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  vector                attack_vector NOT NULL,
  channel               delivery_channel NOT NULL,
  subject_or_headline   TEXT NOT NULL,
  body_ref              TEXT NOT NULL,   -- plantilla/HTML de referencia, sin datos personales embebidos
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
CREATE TABLE campaigns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  template_id    UUID NOT NULL REFERENCES templates(id),
  scheduled_at   TIMESTAMPTZ,
  status         campaign_status NOT NULL DEFAULT 'borrador',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Una fila por (participante, campaña): token de acceso de un solo uso.
CREATE TABLE participant_campaign (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id   UUID NOT NULL REFERENCES participants(id),
  campaign_id      UUID NOT NULL REFERENCES campaigns(id),
  access_token     TEXT UNIQUE NOT NULL,
  delivered_at     TIMESTAMPTZ,
  UNIQUE (participant_id, campaign_id)
);
CREATE INDEX idx_pc_token ON participant_campaign(access_token);

-- ----------------------------------------------------------------------------
-- Bitácora de eventos de interacción. reaction_time_ms se calcula en la
-- capa de aplicación (occurred_at del evento actual - delivered_at) al
-- insertar 'clic' o 'intento_envio'.
CREATE TABLE events (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_campaign_id     UUID NOT NULL REFERENCES participant_campaign(id),
  event_type                  event_type NOT NULL,
  occurred_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  reaction_time_ms            INTEGER
);
CREATE INDEX idx_events_pc ON events(participant_campaign_id);
CREATE INDEX idx_events_type ON events(event_type);

-- ----------------------------------------------------------------------------
-- Encuesta post-sesión / debriefing (TG §9.5 Paso 6). Autoinformado.
CREATE TABLE post_session_survey (
  id                                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_campaign_id              UUID NOT NULL UNIQUE REFERENCES participant_campaign(id),
  fell_for_attack                      BOOLEAN NOT NULL,
  fall_reason                          fall_reason,
  perceived_suspicion_before_action    BOOLEAN,
  recognized_as_simulated              BOOLEAN,
  submitted_at                         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Vista de métricas agregadas — alimenta el dashboard (Objetivo 4) y el
-- export para las gráficas de la tesis (Objetivo 3).
-- ============================================================================
CREATE VIEW v_metrics_by_role_vector AS
SELECT
  p.role,
  t.vector,
  COUNT(DISTINCT pc.id)                                    AS total_expuestos,
  COUNT(DISTINCT e_open.participant_campaign_id)           AS total_abiertos,
  COUNT(DISTINCT e_click.participant_campaign_id)          AS total_clics,
  COUNT(DISTINCT e_submit.participant_campaign_id)         AS total_intentos_envio,
  ROUND(COUNT(DISTINCT e_click.participant_campaign_id)::numeric
        / NULLIF(COUNT(DISTINCT pc.id), 0) * 100, 2)       AS ctr_pct,
  ROUND(COUNT(DISTINCT e_submit.participant_campaign_id)::numeric
        / NULLIF(COUNT(DISTINCT pc.id), 0) * 100, 2)       AS conversion_pct,
  ROUND(AVG(e_click.reaction_time_ms), 0)                  AS tiempo_reaccion_promedio_ms
FROM participant_campaign pc
JOIN participants p  ON p.id = pc.participant_id
JOIN campaigns c     ON c.id = pc.campaign_id
JOIN templates t     ON t.id = c.template_id
LEFT JOIN events e_open   ON e_open.participant_campaign_id = pc.id   AND e_open.event_type = 'abierto'
LEFT JOIN events e_click  ON e_click.participant_campaign_id = pc.id  AND e_click.event_type = 'clic'
LEFT JOIN events e_submit ON e_submit.participant_campaign_id = pc.id AND e_submit.event_type = 'intento_envio'
GROUP BY p.role, t.vector;

CREATE VIEW v_fall_reason_breakdown AS
SELECT
  p.role,
  t.vector,
  s.fall_reason,
  COUNT(*) AS total
FROM post_session_survey s
JOIN participant_campaign pc ON pc.id = s.participant_campaign_id
JOIN participants p ON p.id = pc.participant_id
JOIN campaigns c ON c.id = pc.campaign_id
JOIN templates t ON t.id = c.template_id
WHERE s.fell_for_attack = TRUE
GROUP BY p.role, t.vector, s.fall_reason;

-- Vista por equipo/sala de laboratorio — el formato exacto que se pidió:
-- "el Equipo 5 tuvo 3 participantes que cayeron en el escenario X por el motivo Y".
-- Nunca expone external_hash ni ningún dato individual, solo el agregado del equipo.
CREATE VIEW v_falls_by_team AS
SELECT
  p.team_label,
  t.vector                              AS escenario,
  s.fall_reason                         AS motivo,
  COUNT(*)                              AS participantes_caidos
FROM post_session_survey s
JOIN participant_campaign pc ON pc.id = s.participant_campaign_id
JOIN participants p ON p.id = pc.participant_id
JOIN campaigns c ON c.id = pc.campaign_id
JOIN templates t ON t.id = c.template_id
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

-- ============================================================================
-- Trazabilidad: qué métrica de los documentos fuente responde cada vista/columna
-- ============================================================================
-- Tasa de clic (CTR)                    -> v_metrics_by_role_vector.ctr_pct
-- Tasa de envío / conversión             -> v_metrics_by_role_vector.conversion_pct
-- Tiempo de vacilación / reacción        -> events.reaction_time_ms, v_metrics_by_role_vector.tiempo_reaccion_promedio_ms
-- Susceptibilidad por arma de influencia -> GROUP BY t.vector en ambas vistas
-- Motivo/categoría de caída              -> v_fall_reason_breakdown.fall_reason
-- Segmentación por rol                   -> GROUP BY p.role en ambas vistas
--
-- Las métricas del MODELO DE ML (F1, ROC-AUC, FAR/FRR, latencia de
-- inferencia — TG Tabla 3, §8.2.6) NO viven en esta base de datos: son
-- del pipeline de entrenamiento/evaluación de PAWS (Fase 3 del plan de
-- ejecución), un sistema distinto. Esta base de datos es la del
-- simulador de campañas (Objetivos 1-4 de este mensaje), que alimenta
-- las métricas de SUSCEPTIBILIDAD, no las del CLASIFICADOR.
