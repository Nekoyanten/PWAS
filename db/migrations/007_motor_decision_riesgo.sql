-- ============================================================================
-- Migración 007 — Motor de decisión con umbral de riesgo real (Tabla 1
-- §8.2.1, fila 5 / TG §8.2.5), MODO SOMBRA.
-- Aplica sobre una base que ya tiene las migraciones 001-006.
-- Ejecutar:  psql "$DATABASE_URL" -f db/migrations/007_motor_decision_riesgo.sql
--
-- Motivo: hoy la intervención (jolting) se dispara con un sorteo de
-- probabilidad fijo por envío (`deliveries.jolting_roll`, migración 006) --
-- una simplificación honesta de Fase 1, documentada como tal. La versión
-- final de §8.2.5 la condiciona a un PUNTAJE DE RIESGO calculado en tiempo
-- real a partir de la conducta de ESE participante en ESE mensaje (el
-- modelo temporal TCN+Transformer entrenado en el pipeline de ML, ver
-- docs/2026-09-06_pipeline-ml-offline.md), no a una moneda echada al aire.
--
-- Por qué en MODO SOMBRA y no como gate real todavía: el modelo se entrenó
-- con etiquetas 100% SINTÉTICAS (0 encuestas reales al 7 de sept., el piloto
-- real sigue sin arrancar) -- ver docs/2026-09-07_motor-decision-riesgo.md,
-- sección de límites. Dejar que un clasificador sin validar decida A QUIÉN
-- se le muestra de verdad la intervención condicionaría el experimento real
-- a un modelo no verificado. Por eso esta migración agrega el cálculo y el
-- almacenamiento del puntaje (para análisis/tesis) SIN tocar la lógica que
-- hoy decide si se muestra el aviso (`joltingEligible` en tracking.js sigue
-- usando `jolting_roll`, sin cambios) -- el umbral queda listo y configurable
-- para cuando haya etiquetas reales y se decida activar el gate de verdad.
-- ============================================================================

BEGIN;

-- Umbral (0..1): a partir de qué puntaje de riesgo el motor de decisión
-- HABRÍA mostrado la intervención, si estuviera gateando de verdad. Mismo
-- patrón que `campaigns.jolting_probability` (migración 006): un valor por
-- campaña, configurable desde el panel admin, que NO recalcula deliveries
-- ya existentes.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS risk_threshold NUMERIC(4,3) NOT NULL DEFAULT 0.500
    CHECK (risk_threshold >= 0 AND risk_threshold <= 1);
COMMENT ON COLUMN campaigns.risk_threshold IS
  'Umbral (0..1) del motor de decisión por riesgo (migración 007, modo SOMBRA): a partir de qué puntaje se habría mostrado la intervención. No gatea nada todavía -- ver deliveries.risk_would_trigger.';

-- Puntaje de riesgo [0,1] calculado por el modelo temporal (TCN+Transformer,
-- sigmoid del logit) sobre la conducta de mouse/teclado capturada mientras el
-- participante tenía abierto ESTE mensaje, calculado al hacer clic en el CTA
-- (GET /:token/d/:deliveryId/go). NULL = todavía no se pudo calcular (sin
-- captura conductual suficiente, modelo no disponible, o el delivery no es
-- un ataque) -- nunca bloquea ni retrasa el flujo del participante: se
-- calcula en segundo plano, después de responder la página.
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS risk_score NUMERIC(6,5),
  ADD COLUMN IF NOT EXISTS risk_would_trigger BOOLEAN,
  ADD COLUMN IF NOT EXISTS risk_scored_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS risk_model_version TEXT,
  ADD COLUMN IF NOT EXISTS risk_score_error TEXT;
COMMENT ON COLUMN deliveries.risk_score IS
  'Puntaje de riesgo [0,1] del modelo temporal (migración 007), calculado en segundo plano al hacer clic en el mensaje. NULL si no se pudo calcular (ver risk_score_error).';
COMMENT ON COLUMN deliveries.risk_would_trigger IS
  'Decisión SOMBRA: risk_score >= campaigns.risk_threshold vigente AL MOMENTO de calcular el puntaje (fijo desde entonces, igual que jolting_roll -- cambiar el umbral después no recalcula deliveries ya evaluados). NO decide si se muestra la intervención real todavía.';
COMMENT ON COLUMN deliveries.risk_model_version IS
  'Huella (sha256) del archivo .onnx usado para este puntaje -- para poder distinguir puntajes de antes/después de reentrenar el modelo.';
COMMENT ON COLUMN deliveries.risk_score_error IS
  'Si el cálculo falló (sin captura conductual, modelo no cargado, etc.), motivo en texto plano -- para diagnóstico, nunca bloquea el flujo del participante.';

COMMIT;
