-- ============================================================================
-- Migración 015 — Captura biométrica facial (extensión fuera del alcance
-- original de TG §8.2 Fase 1 -- ver docs/2026-09-12_captura-facial-biometrica.md
-- para el porqué: el usuario pidió agregarla explícitamente, y confirmó que el
-- comité de ética aprobó por separado la captura de cámara/rostro, además de
-- la aprobación ya existente para mouse/teclado).
-- Aplica sobre una base que ya tiene las migraciones 001-014.
-- Ejecutar:  psql "$DATABASE_URL" -f db/migrations/015_captura_facial_biometrica.sql
--
-- Motivo: medir "duda y hesitación" (la variable de interés de esta
-- investigación) solo con mouse/teclado deja fuera señales faciales que la
-- literatura de FACS/blendshapes asocia con vacilación: parpadeo, apertura
-- ocular, fijación/aversión de la mirada, y tensión de ceja/boca. Este módulo
-- agrega SOLO el almacenamiento de esas señales YA DERIVADAS en el navegador
-- del participante -- nunca video, nunca imágenes, nunca coordenadas de los
-- 478 landmarks de MediaPipe. Es el mismo invariante de privacidad que ya
-- rige `behavior_events.key_code` (solo la tecla física, nunca el carácter),
-- llevado al dominio facial: solo escalares numéricos pequeños por muestra.
--
-- Diseño elegido y por qué (mismo patrón que la captura conductual --
-- migraciones 004/008 -- deliberadamente, para no introducir una convención
-- nueva donde ya existe una que funciona):
--   * Tres tablas, no una: `facial_sessions` (una fila por página con la
--     cámara activa), `facial_events` (una fila por muestra derivada dentro
--     de esa sesión) y `facial_session_features` (una fila por sesión con
--     agregados + z-score contra línea base de calibración), igual que
--     `behavior_sessions` / `behavior_events` / `behavior_session_features`.
--   * `facial_sessions.id` lo genera el NAVEGADOR (`crypto.randomUUID()`),
--     igual razón que en behavior_sessions: permite reintentar lotes sin
--     duplicar la sesión y no necesita una ida y vuelta previa al servidor.
--   * `t_ms` relativo (no TIMESTAMPTZ por muestra), mismo motivo que
--     behavior_events: evita depender del reloj del navegador para el orden
--     temporal y es más compacto.
--   * Los valores de blendshape de MediaPipe (0.0-1.0) se combinan en el
--     propio navegador (apps/api/public/js/facial-capture.js) en 5 señales
--     simples -- apertura ocular, parpadeo, mirada horizontal/vertical,
--     tensión de ceja, tensión de boca -- ANTES de salir del dispositivo.
--     Los 478 landmarks 3D y los 52 blendshapes crudos NUNCA se envían al
--     servidor ni se guardan: solo estos escalares derivados.
--   * `face_detected` (BOOLEAN) por muestra: cuando MediaPipe no detecta
--     rostro (el participante se movió fuera de cuadro, luz insuficiente,
--     cámara ocupada), el resto de las columnas de esa fila quedan NULL --
--     es información real ("cuánto del tiempo hay señal válida"), no ruido a
--     descartar.
--   * Requiere un consentimiento SEPARADO del consentimiento general del
--     piloto (`participants.camera_consent_given`), porque activar la cámara
--     es una sensibilidad muy distinta a registrar mouse/teclado -- nunca se
--     asume a partir del consentimiento general, aunque ambos se pidan en la
--     misma pantalla de bienvenida.
--   * Igual que en la migración 008, las features agregadas se recalculan
--     por lote a pedido (`POST /api/dashboard/recompute-facial-features`),
--     no en cada ingesta: la línea base de calibración de cada participante
--     depende del conjunto completo de sesiones, no de una sola.
-- ============================================================================

BEGIN;

ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS camera_consent_given     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS camera_consent_timestamp TIMESTAMPTZ;

COMMENT ON COLUMN participants.camera_consent_given IS
  'Consentimiento SEPARADO del consentimiento general (consent_given) para activar la cámara y capturar señales faciales derivadas. Nunca se asume TRUE a partir de consent_given, aunque se pidan en la misma pantalla de bienvenida (ver renderWelcome en decoy.js).';
COMMENT ON COLUMN participants.camera_consent_timestamp IS
  'Cuándo se marcó camera_consent_given = TRUE. NULL si nunca se otorgó.';

DO $$ BEGIN
  CREATE TYPE facial_event_type AS ENUM ('facial_sample', 'face_lost', 'face_regained');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Una fila por página con la cámara activa (mismo criterio de `phase` que
-- behavior_sessions: 'calibration' | 'app' | 'message' | 'landing' | 'survey').
CREATE TABLE IF NOT EXISTS facial_sessions (
  id                       UUID PRIMARY KEY,
  participant_campaign_id  UUID NOT NULL REFERENCES participant_campaign(id) ON DELETE CASCADE,
  delivery_id              UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  phase                    TEXT NOT NULL,
  started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_flush_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  camera_w                 SMALLINT,
  camera_h                 SMALLINT,
  sample_count             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_facial_sessions_pc       ON facial_sessions(participant_campaign_id);
CREATE INDEX IF NOT EXISTS idx_facial_sessions_delivery ON facial_sessions(delivery_id);

-- Una fila por muestra derivada (~15 Hz, ver facial-capture.js). Todas las
-- columnas de señal son NULL cuando face_detected = FALSE.
CREATE TABLE IF NOT EXISTS facial_events (
  id                  BIGSERIAL PRIMARY KEY,
  facial_session_id   UUID NOT NULL REFERENCES facial_sessions(id) ON DELETE CASCADE,
  t_ms                INTEGER NOT NULL,
  event_type          facial_event_type NOT NULL DEFAULT 'facial_sample',
  face_detected       BOOLEAN NOT NULL DEFAULT TRUE,
  eye_openness        REAL,  -- 0..1, promedio de ambos ojos. 1 - (eyeBlinkLeft+eyeBlinkRight)/2.
  blink               BOOLEAN, -- TRUE si eye_openness cruzó el umbral de parpadeo en esta muestra.
  gaze_x              REAL,  -- proxy horizontal de mirada, aprox. -1 (izquierda) .. 1 (derecha). Ver facial-capture.js.
  gaze_y              REAL,  -- proxy vertical de mirada, aprox. -1 (arriba) .. 1 (abajo).
  brow_tension        REAL,  -- 0..1, promedio de browDownLeft/Right + browInnerUp (ceño fruncido).
  mouth_tension       REAL   -- 0..1, promedio de mouthPress Left/Right + mouthStretch Left/Right.
);
CREATE INDEX IF NOT EXISTS idx_facial_events_session_t ON facial_events(facial_session_id, t_ms);

COMMENT ON TABLE facial_events IS
  'Escalares derivados de los blendshapes de MediaPipe FaceLandmarker, calculados enteramente en el navegador del participante (apps/api/public/js/facial-capture.js). NUNCA contiene video, imágenes, ni los 478 landmarks/52 blendshapes crudos -- mismo invariante de privacidad que behavior_events.key_code, aplicado al dominio facial.';

CREATE TABLE IF NOT EXISTS facial_session_features (
  session_id                    UUID PRIMARY KEY REFERENCES facial_sessions(id) ON DELETE CASCADE,
  participant_campaign_id       UUID NOT NULL REFERENCES participant_campaign(id) ON DELETE CASCADE,
  phase                         TEXT NOT NULL,

  n_samples                     INTEGER NOT NULL DEFAULT 0,
  face_detected_ratio           DOUBLE PRECISION, -- fracción de muestras con face_detected = TRUE (calidad de la señal).

  blink_count                   INTEGER NOT NULL DEFAULT 0,
  blink_rate_per_min            DOUBLE PRECISION,
  eye_openness_mean             DOUBLE PRECISION,
  eye_openness_std              DOUBLE PRECISION,

  gaze_dispersion_x             DOUBLE PRECISION, -- desviación estándar de gaze_x en la sesión (fijación baja = disperso).
  gaze_dispersion_y             DOUBLE PRECISION,
  gaze_mean_abs_x               DOUBLE PRECISION, -- magnitud promedio de desvío de mirada del centro (proxy de aversión).
  gaze_mean_abs_y               DOUBLE PRECISION,

  brow_tension_mean             DOUBLE PRECISION,
  brow_tension_std              DOUBLE PRECISION,
  mouth_tension_mean            DOUBLE PRECISION,
  mouth_tension_std             DOUBLE PRECISION,

  -- Z-score contra la línea base de calibración del propio participante (o
  -- poblacional si no tiene), mismo patrón que behavior_session_features.
  blink_rate_per_min_z          DOUBLE PRECISION,
  brow_tension_mean_z           DOUBLE PRECISION,
  mouth_tension_mean_z          DOUBLE PRECISION,
  gaze_dispersion_x_z           DOUBLE PRECISION,
  baseline_z_source             TEXT,  -- 'personal' o 'poblacional'

  feature_version               TEXT NOT NULL,
  computed_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE facial_session_features IS
  'Features agregadas por sesión de captura facial -- tasa de parpadeo, apertura ocular, dispersión/aversión de mirada, tensión de ceja y boca -- y sus z-scores contra la línea base de calibración. Recalculadas a pedido por apps/api/src/lib/facialFeatures.js (POST /api/dashboard/recompute-facial-features). Es almacenamiento para análisis OFFLINE -- deliberadamente NO se integra al motor de riesgo en tiempo real (riskScore.js): no existe todavía un modelo entrenado que combine responsablemente señales de mouse+teclado+rostro, y hacerlo sin uno sería inventar un criterio de decisión no validado.';
COMMENT ON COLUMN facial_session_features.baseline_z_source IS
  '"personal": el participante tenía sesión de calibración propia con cámara activa. "poblacional": se usó media/desviación de todas las sesiones del recálculo, a falta de calibración propia.';
COMMENT ON COLUMN facial_session_features.feature_version IS
  'Versión del código de cálculo (facialFeatures.FEATURE_VERSION) -- fórmulas deterministas, no un modelo entrenado.';

CREATE INDEX IF NOT EXISTS idx_facial_session_features_pc    ON facial_session_features(participant_campaign_id);
CREATE INDEX IF NOT EXISTS idx_facial_session_features_phase ON facial_session_features(phase);

-- Mismo criterio que la migración 009: RLS sin políticas explícitas = deny
-- por defecto para los roles anon/authenticated de PostgREST; app_service
-- (BYPASSRLS) sigue viendo todo igual.
ALTER TABLE public.facial_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facial_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facial_session_features ENABLE ROW LEVEL SECURITY;

COMMIT;
