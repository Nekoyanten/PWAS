-- ============================================================================
-- Migración 005 — Paso 2 del protocolo: calibración de línea base (~30s)
-- Aplica sobre una base que ya tiene las migraciones 001-004.
-- Ejecutar:  psql "$DATABASE_URL" -f db/migrations/005_calibration.sql
--
-- Motivo: TG §9.5 (protocolo del piloto) describe un paso de calibración de
-- ~30s ENTRE el consentimiento y la tarea de navegación, para fijar la línea
-- base de cómo se mueve/teclea CADA participante antes de exponerlo a
-- cualquier estímulo. Sin esta línea base, el análisis de 8.2.3 solo tendría
-- "cómo se movió durante el ataque" sin nada con qué compararlo. Antes de
-- esta migración, el flujo pasaba directo de consentimiento a /app.
--
-- Solo agrega dos columnas de timestamp a `participant_campaign` — mismo
-- patrón ya usado para `session_started_at` / `finished_at`, no una tabla
-- nueva: no hace falta más que "¿cuándo empezó?" / "¿cuándo terminó?" para
-- poder filtrar después una sesión de calibración sospechosamente corta si
-- hiciera falta. La captura conductual EN SÍ durante la calibración
-- (mousemove/click/keydown/keyup) ya tiene dónde guardarse — la migración
-- 004 (`behavior_sessions`/`behavior_events`) es genérica por `phase`, y
-- esta calibración usa `phase = 'calibration'` sin necesitar ningún cambio
-- ahí.
-- ============================================================================

BEGIN;

ALTER TABLE participant_campaign
  ADD COLUMN IF NOT EXISTS calibration_started_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS calibration_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN participant_campaign.calibration_started_at IS
  'Cuándo se le mostró por primera vez la pantalla de calibración (TG §9.5, paso 2). NULL si todavía no llega a esa pantalla.';
COMMENT ON COLUMN participant_campaign.calibration_completed_at IS
  'Cuándo terminó la calibración y pudo entrar a /app. NULL bloquea el acceso a /app (ver GET /t/:token/app en tracking.js) — es un paso obligatorio del protocolo, no opcional.';

COMMIT;
