-- ============================================================================
-- PAWS Campaign Platform — Esquema de base de datos (PostgreSQL 14+)
-- ============================================================================
-- NOTA DE CUMPLIMIENTO (no negociable por defecto — ver PS §3.2 y TG §9.1):
--   1. Ninguna tabla contiene nombre, correo real, documento de identidad
--      ni IP completa. `external_hash` es un hash irreversible generado
--      FUERA de este sistema (nunca aquí) a partir del identificador real.
--   2. El evento 'intento_envio' registra SOLO que el formulario fue
--      enviado (booleano + timestamp). El backend descarta el payload del
--      formulario ANTES de que llegue a la base de datos. No existe ninguna
--      columna para contenido de credenciales, ni siquiera enmascarado.
--   3. El evento 'permiso_concedido' registra SOLO que el participante pulsó
--      "Autorizar" en una pantalla de autorización SIMULADA (estilo OAuth) y
--      qué alcance se pedía (etiqueta: 'perfil' | 'tareas' | 'agenda' | ...).
--      NO se solicita ni se accede a ningún recurso real: no hay cámara,
--      micrófono, ubicación, contactos ni nada del dispositivo.
--   4. `fall_reason` es autoinformado por el participante en el debriefing
--      (TG §9.5 Paso 6), no inferido automáticamente.
--   5. La telemetría de usabilidad (participant_campaign.usability_interactions)
--      es un simple CONTADOR de interacciones benignas con el tablero. No
--      registra el contenido de las tarjetas ni texto del participante.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE participant_role AS ENUM ('estudiante', 'profesor', 'directivo');
CREATE TYPE group_assignment AS ENUM ('control', 'experimental');
CREATE TYPE attack_vector AS ENUM ('autoridad', 'urgencia', 'escasez', 'prueba_social', 'curiosidad');
CREATE TYPE delivery_channel AS ENUM ('email_simulado', 'sms_simulado', 'web');
CREATE TYPE event_type AS ENUM ('entregado', 'abierto', 'clic', 'intento_envio', 'reportado', 'permiso_concedido', 'intervencion_mostrada', 'intervencion_cancelada');
CREATE TYPE landing_kind AS ENUM ('form', 'permiso');   -- 'permiso' = pantalla de autorización simulada (sin hardware)
CREATE TYPE message_kind AS ENUM ('email', 'task');     -- cómo se muestra el mensaje en la bandeja de TaskFlow
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
  team_label          TEXT,
  group_assignment    group_assignment,
  consent_given       BOOLEAN NOT NULL DEFAULT FALSE,
  consent_timestamp   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON COLUMN participants.external_hash IS
  'Hash irreversible del identificador real, calculado fuera de este sistema. Nunca almacenar el valor original.';
COMMENT ON COLUMN participants.team_label IS
  'Etiqueta de agrupación del laboratorio (equipo, sala, turno). El admin entrega los mensajes por equipo.';

-- ----------------------------------------------------------------------------
-- Plantilla reutilizable de mensaje. El admin puede usarla tal cual o como
-- punto de partida para redactar un mensaje de campaña.
CREATE TABLE templates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  vector                attack_vector NOT NULL,
  channel               delivery_channel NOT NULL DEFAULT 'web',
  kind                  message_kind NOT NULL DEFAULT 'email',
  is_attack             BOOLEAN NOT NULL DEFAULT TRUE,
  sender_label          TEXT,
  subject_or_headline   TEXT NOT NULL,
  message_body          TEXT,
  cta_label             TEXT NOT NULL DEFAULT 'Abrir',
  landing_kind          landing_kind NOT NULL DEFAULT 'form',
  landing_config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  body_ref              TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
CREATE TABLE campaigns (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  template_id          UUID REFERENCES templates(id),
  seed                 TEXT NOT NULL DEFAULT substr(md5(random()::text), 1, 12),
  jolting_probability  NUMERIC(4,3) NOT NULL DEFAULT 1.000 CHECK (jolting_probability >= 0 AND jolting_probability <= 1),
  risk_threshold       NUMERIC(4,3) NOT NULL DEFAULT 0.500 CHECK (risk_threshold >= 0 AND risk_threshold <= 1),
  scheduled_at         TIMESTAMPTZ,
  status               campaign_status NOT NULL DEFAULT 'borrador',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON COLUMN campaigns.seed IS
  'Semilla para sugerir un reparto balanceado y reproducible de vectores entre equipos (el admin puede seguirlo o no).';
COMMENT ON COLUMN campaigns.jolting_probability IS
  'Probabilidad (0..1) de que un envío de un mensaje con jolting_enabled=TRUE muestre el aviso "Espera un momento..." al grupo experimental (migración 006). 1.0 = siempre. No afecta al grupo control.';
COMMENT ON COLUMN campaigns.risk_threshold IS
  'Umbral (0..1) del motor de decisión por riesgo (migración 007, modo SOMBRA): a partir de qué puntaje se habría mostrado la intervención. No gatea nada todavía -- ver deliveries.risk_would_trigger.';

CREATE TABLE campaign_templates (
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  template_id  UUID NOT NULL REFERENCES templates(id),
  PRIMARY KEY (campaign_id, template_id)
);

-- ----------------------------------------------------------------------------
-- Una fila por (participante, campaña): token de acceso de un solo uso +
-- estado de la sesión del piloto.
CREATE TABLE participant_campaign (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id         UUID NOT NULL REFERENCES participants(id),
  campaign_id            UUID NOT NULL REFERENCES campaigns(id),
  access_token           TEXT UNIQUE NOT NULL,
  assigned_template_id   UUID REFERENCES templates(id),   -- sugerencia del reparto por semilla (no se usa para métricas)
  session_started_at     TIMESTAMPTZ,
  usability_interactions INTEGER NOT NULL DEFAULT 0,
  finished_at            TIMESTAMPTZ,
  calibration_started_at   TIMESTAMPTZ,  -- TG §9.5 paso 2: línea base de mouse/teclado antes de la tarea de navegación
  calibration_completed_at TIMESTAMPTZ,  -- NULL bloquea el acceso a /app (paso obligatorio, no opcional)
  UNIQUE (participant_id, campaign_id)
);
CREATE INDEX idx_pc_token ON participant_campaign(access_token);

-- ----------------------------------------------------------------------------
-- Mensaje concreto de una campaña, redactado por el admin (desde una
-- plantilla o desde cero). Se envía a uno o varios equipos.
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  template_id     UUID REFERENCES templates(id),
  kind            message_kind NOT NULL DEFAULT 'email',
  is_attack       BOOLEAN NOT NULL DEFAULT FALSE,
  vector          attack_vector,                 -- copia del vector de la plantilla (para métricas), NULL si no es ataque
  sender_label    TEXT,
  subject         TEXT NOT NULL,
  body            TEXT,
  cta_label       TEXT,
  landing_kind    landing_kind,
  landing_config  JSONB NOT NULL DEFAULT '{}'::jsonb,
  jolting_enabled BOOLEAN NOT NULL DEFAULT TRUE,  -- migración 006: si es FALSE, este mensaje nunca muestra el aviso de intervención, a nadie
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_campaign ON messages(campaign_id);
COMMENT ON COLUMN messages.jolting_enabled IS
  'Si es FALSE, este mensaje de ataque NUNCA muestra el aviso "Espera un momento...", para ningún participante ni grupo (migración 006).';

-- Cada envío de un mensaje a un participante. Reenviar el mismo estímulo =
-- un mensaje nuevo con su propia tanda de deliveries -> se mide por separado.
CREATE TABLE deliveries (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id              UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  participant_campaign_id UUID NOT NULL REFERENCES participant_campaign(id) ON DELETE CASCADE,
  delivered_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  jolting_roll            BOOLEAN NOT NULL DEFAULT TRUE,  -- migración 006: sorteo fijo (sembrado) contra campaigns.jolting_probability, calculado una sola vez al crear el delivery
  risk_score              NUMERIC(6,5),  -- migración 007 (SOMBRA): puntaje [0,1] del modelo temporal, calculado en segundo plano al hacer clic
  risk_would_trigger      BOOLEAN,       -- migración 007: risk_score >= campaigns.risk_threshold vigente al momento del cálculo -- no gatea nada todavía
  risk_scored_at          TIMESTAMPTZ,
  risk_model_version      TEXT,          -- sha256 del .onnx usado
  risk_score_error        TEXT,          -- motivo si no se pudo calcular (nunca bloquea el flujo del participante)
  UNIQUE (message_id, participant_campaign_id)
);
COMMENT ON COLUMN deliveries.jolting_roll IS
  'Resultado fijo del sorteo de probabilidad (campaigns.jolting_probability), sembrado con seed+message_id+participant_campaign_id (migración 006). Junto con messages.jolting_enabled y group_assignment=''experimental'' decide si tracking.js muestra la intervención.';
COMMENT ON COLUMN deliveries.risk_score IS
  'Puntaje de riesgo [0,1] del modelo temporal (migración 007), calculado en segundo plano al hacer clic en el mensaje. NULL si no se pudo calcular (ver risk_score_error).';
COMMENT ON COLUMN deliveries.risk_would_trigger IS
  'Decisión SOMBRA: risk_score >= campaigns.risk_threshold vigente AL MOMENTO de calcular el puntaje (fijo desde entonces, igual que jolting_roll). NO decide si se muestra la intervención real todavía.';
CREATE INDEX idx_deliveries_pc ON deliveries(participant_campaign_id);

-- ----------------------------------------------------------------------------
-- Bitácora de eventos. Cada evento pertenece a un delivery concreto (salvo
-- 'entregado', que se crea junto con el delivery). reaction_time_ms se
-- calcula en la app: occurred_at del evento - delivered_at del delivery.
CREATE TABLE events (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_campaign_id     UUID NOT NULL REFERENCES participant_campaign(id) ON DELETE CASCADE,
  delivery_id                 UUID REFERENCES deliveries(id) ON DELETE CASCADE,
  event_type                  event_type NOT NULL,
  occurred_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  reaction_time_ms            INTEGER,
  detail                      TEXT   -- SOLO metadatos no sensibles (p.ej. 'perfil' para permiso_concedido). Nunca contenido de formularios.
);
CREATE INDEX idx_events_pc ON events(participant_campaign_id);
CREATE INDEX idx_events_delivery ON events(delivery_id);
CREATE INDEX idx_events_type ON events(event_type);

-- ----------------------------------------------------------------------------
-- Encuesta post-sesión / debriefing (TG §9.5 Paso 6). Autoinformado.
-- Se atribuye al "ataque principal" (primary_message_id): aquel con el que
-- el participante interactuó, o el último recibido.
CREATE TABLE post_session_survey (
  id                                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_campaign_id              UUID NOT NULL UNIQUE REFERENCES participant_campaign(id) ON DELETE CASCADE,
  primary_message_id                   UUID REFERENCES messages(id),
  fell_for_attack                      BOOLEAN NOT NULL,
  fall_reason                          fall_reason,
  perceived_suspicion_before_action    BOOLEAN,
  recognized_as_simulated              BOOLEAN,
  vector_specific_answer               TEXT,
  free_comment                         TEXT,
  submitted_at                         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Vistas de métricas agregadas. La unidad es el DELIVERY de un mensaje de
-- ataque: un participante que recibe 2 ataques de vectores distintos cuenta
-- una vez en cada vector.
-- ============================================================================
CREATE VIEW v_metrics_by_role_vector AS
SELECT
  p.role,
  m.vector,
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
SELECT p.team_label, m.vector AS escenario, s.fall_reason AS motivo,
       COUNT(*) AS participantes_caidos
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

-- ============================================================================
-- Trazabilidad de métricas -> ver versión anterior del archivo. Sin cambios
-- de significado: CTR, conversión, tiempo de reacción, susceptibilidad por
-- vector y por rol, motivo de caída, reconocimiento del engaño.
-- Las métricas del MODELO DE ML viven en otro sistema (pipeline de PAWS).
-- ============================================================================
