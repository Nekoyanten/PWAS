-- ============================================================================
-- Migración 003 — Capa de intervención PAWS (jolting cognitivo, TG §8.2.5)
-- Aplica sobre una base que ya tiene las migraciones 001 y 002.
-- Ejecutar:  psql "$DATABASE_URL" -f db/migrations/003_paws_intervention.sql
--
-- Motivo: `participants.group_assignment` ('control' | 'experimental') existía
-- en el esquema desde el inicio pero ningún endpoint lo leía todavía — el
-- grupo experimental recibía exactamente el mismo flujo que el control, por
-- lo que el sistema no podía todavía contrastar H1/H3 (Capítulo IX, §9.2).
-- Esta migración solo agrega los dos tipos de evento que necesita el nuevo
-- endpoint /t/:token/d/:deliveryId/go para registrar la intervención; no
-- cambia ninguna tabla ni ningún dato existente.
-- ============================================================================

BEGIN;

-- ALTER TYPE ... ADD VALUE no admite IF NOT EXISTS en todas las versiones;
-- se envuelve para ser idempotente, igual que en la migración 001.
DO $$ BEGIN
  ALTER TYPE event_type ADD VALUE 'intervencion_mostrada';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE event_type ADD VALUE 'intervencion_cancelada';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;

-- NOTA: en PostgreSQL, un valor de enum agregado con ALTER TYPE ... ADD VALUE
-- no puede usarse en la MISMA transacción en la que se agrega (limitación de
-- Postgres, no de esta migración). Por eso el COMMIT va antes de que el
-- código de la aplicación use 'intervencion_mostrada' / 'intervencion_cancelada'.
