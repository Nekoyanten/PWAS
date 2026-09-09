-- ============================================================================
-- Migración 008 — Etiquetado fino de captura conductual (Tabla 1 §8.2.1,
-- módulo 7 "Almacenamiento: eventos, etiquetas, resultados").
-- Aplica sobre una base que ya tiene las migraciones 001-007.
-- Ejecutar:  psql "$DATABASE_URL" -f db/migrations/008_etiquetado_fino.sql
--
-- Motivo: desde la migración 004, `behavior_events` guarda la captura
-- conductual CRUDA (una fila por muestra de mouse/teclado). Eso alcanzaba
-- para exportar un CSV y correr el pipeline de ML en Python (ml/src/), pero
-- las features REALES por sesión (AUC/SE/MD de la trayectoria de mouse,
-- latencias de tecleo, y sus z-scores contra la línea base de calibración
-- de cada participante) solo existían mientras ese pipeline corría, en
-- memoria de un proceso Python aparte -- nunca quedaban en esta base de
-- datos. Módulo 7 de la Tabla 1 seguía "parcial" por exactamente esto: solo
-- eventos gruesos, sin el etiquetado fino de esas features.
--
-- Diseño elegido y por qué:
--   * Una fila por SESIÓN (`behavior_sessions.id`), no por evento -- las
--     features son agregados de todos los eventos de esa sesión, igual
--     que una fila de `build_feature_table()` en ml/src/dataset.py.
--   * Las columnas son exactamente FEATURE_COLUMNS + FEATURE_COLUMNS_Z de
--     ml/src/dataset.py -- el mismo conjunto de features que ya entrena los
--     baselines tabulares (SVM/RF/XGBoost), para que esta tabla sea
--     literalmente "esas mismas features, pero persistidas" y no un cálculo
--     paralelo con su propia definición.
--   * Se calculan en JavaScript (apps/api/src/lib/behaviorFeatures.js), no
--     invocando Python: el pipeline de Python sigue existiendo para
--     entrenar/evaluar modelos, pero para simplemente ETIQUETAR cada sesión
--     con sus features y dejarlas consultables desde el panel admin/el
--     dashboard, levantar un proceso Python por cada recálculo habría sido
--     una dependencia operativa innecesaria -- el mismo razonamiento que ya
--     llevó a portar el preprocesamiento a JS para el motor de riesgo
--     (migración 007). La paridad numérica con Python se verifica con un
--     fixture (ver ml/scripts/gen_features_fixture.py).
--   * `feature_version` (no `model_version`: acá no hay modelo, son fórmulas
--     deterministas) deja constancia de qué versión del código de cálculo
--     produjo cada fila, por si la definición de alguna feature cambia más
--     adelante.
--   * Se recalculan TODAS las sesiones en una sola pasada, a pedido (no en
--     cada `POST /behavior`): una sesión no tiene una señal de "cerrada", y
--     la línea base de calibración de cada participante se calcula sobre
--     TODO el conjunto de sesiones a la vez -- recalcularla en cada lote
--     sería trabajo repetido sin ganar nada (esto no gatea nada en tiempo
--     real, es almacenamiento para análisis, a diferencia del motor de
--     riesgo de la migración 007). Se dispara desde el panel admin
--     (`POST /api/dashboard/recompute-features`).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS behavior_session_features (
  session_id                    UUID PRIMARY KEY REFERENCES behavior_sessions(id) ON DELETE CASCADE,
  participant_campaign_id       UUID NOT NULL REFERENCES participant_campaign(id) ON DELETE CASCADE,
  phase                         TEXT NOT NULL,

  -- Trayectoria de mouse (ml/src/features.py: mouse_trajectory_features).
  mouse_n_points                INTEGER NOT NULL DEFAULT 0,
  mouse_auc                     DOUBLE PRECISION,
  mouse_se                      DOUBLE PRECISION,
  mouse_md                      DOUBLE PRECISION,
  mouse_path_length             DOUBLE PRECISION,
  mouse_straight_line_distance  DOUBLE PRECISION,
  mouse_efficiency              DOUBLE PRECISION,
  mouse_mean_velocity           DOUBLE PRECISION,
  mouse_std_velocity            DOUBLE PRECISION,
  mouse_mean_acceleration       DOUBLE PRECISION,
  mouse_std_acceleration        DOUBLE PRECISION,

  -- Latencias de tecleo (ml/src/features.py: keystroke_features). Solo
  -- tiempos entre teclas físicas -- nunca el carácter escrito (mismo
  -- invariante de privacidad de `behavior_events.key_code`).
  key_n_keys                    INTEGER NOT NULL DEFAULT 0,
  key_mean_dwell_ms             DOUBLE PRECISION,
  key_std_dwell_ms              DOUBLE PRECISION,
  key_mean_flight_ms            DOUBLE PRECISION,
  key_std_flight_ms             DOUBLE PRECISION,

  -- Z-score contra la línea base de calibración (ml/src/preprocess.py).
  mouse_mean_velocity_z         DOUBLE PRECISION,
  key_mean_dwell_ms_z           DOUBLE PRECISION,
  key_mean_flight_ms_z          DOUBLE PRECISION,
  baseline_z_source             TEXT,  -- 'personal' o 'poblacional'

  feature_version               TEXT NOT NULL,
  computed_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE behavior_session_features IS
  'Etiquetado fino (TG §8.2.1 Tabla 1, módulo 7): features REALES por sesión de captura conductual -- AUC/SE/MD de mouse, latencias de tecleo, y sus z-scores contra la línea base de calibración -- recalculadas a pedido por apps/api/src/lib/behaviorFeatures.js (puerto de ml/src/features.py y ml/src/preprocess.py). No es un gate ni una decisión: es almacenamiento para análisis, exportable via GET /api/export/session-features.csv.';
COMMENT ON COLUMN behavior_session_features.baseline_z_source IS
  '"personal": el participante tenía sesión de calibración propia. "poblacional": se usó media/desviación de todas las sesiones del recálculo, a falta de calibración propia.';
COMMENT ON COLUMN behavior_session_features.feature_version IS
  'Versión del código de cálculo (behaviorFeatures.FEATURE_VERSION), no de un modelo -- estas son fórmulas deterministas, no un clasificador entrenado.';

CREATE INDEX IF NOT EXISTS idx_behavior_session_features_pc    ON behavior_session_features(participant_campaign_id);
CREATE INDEX IF NOT EXISTS idx_behavior_session_features_phase ON behavior_session_features(phase);

COMMIT;
