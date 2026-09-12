-- ============================================================================
-- Migración 014 — Revoca el acceso público (anon/authenticated) a las 4
-- vistas de métricas agregadas, y las pasa a SECURITY INVOKER.
--
-- Contexto: auditoría de preparación para un laboratorio real (11 de
-- septiembre). El advisor de seguridad de Supabase marcó las 4 vistas de
-- schema.sql (v_metrics_by_role_vector, v_fall_reason_breakdown,
-- v_falls_by_team, v_team_summary) como "Security Definer View" (nivel
-- ERROR). Se verificó contra información de roles de Postgres que el
-- problema es real y explotable, no solo teórico:
--
--   - Las 4 vistas tenían GRANT de SELECT/INSERT/UPDATE/DELETE/TRUNCATE
--     para los roles `anon` y `authenticated` -- los mismos que usa la API
--     REST autogenerada de Supabase (PostgREST) con la anon key PÚBLICA
--     del proyecto (la que es seguro exponer en un cliente porque se asume
--     que no da acceso a nada sensible).
--   - Al no llevar `security_invoker = true` (opción disponible desde
--     Postgres 15+; este proyecto corre Postgres 17), una vista se ejecuta
--     con los privilegios de quien la CREÓ, no de quien la consulta -- así
--     que ni siquiera activar RLS con políticas reales en las tablas de
--     abajo (participants, deliveries, events, post_session_survey, etc.)
--     habría bloqueado el acceso vía estas vistas.
--   - La migración 009 (rls_hardening_no_anon_access) endureció las TABLAS
--     pero nunca tocó estas 4 vistas -- quedaron expuestas desde que se
--     crearon en schema.sql/001_taskflow_decoy.sql.
--
-- Resultado antes de este fix: cualquiera con la anon key pública del
-- proyecto podía leer (y, en teoría, intentar escribir) las tasas de caída
-- por equipo/vector/motivo y las métricas de apertura/clic/conversión por
-- rol y técnica -- exactamente los resultados que un laboratorio real con
-- personas de verdad necesita mantener confidenciales, sin pasar por la
-- ADMIN_API_KEY de esta app ni por su propia autenticación.
--
-- La app (apps/api, ver src/db.js) nunca ha usado la API REST de Supabase
-- -- se conecta directo por Postgres como `app_service` (BYPASSRLS, ver
-- migración 011) -- así que revocar el acceso de anon/authenticated y
-- pasar las vistas a SECURITY INVOKER no le quita ninguna funcionalidad;
-- solo cierra el acceso público que nunca debió existir.
--
-- Ejecutar:  psql "$DATABASE_URL" -f db/migrations/014_revoca_acceso_publico_vistas_metricas.sql
-- ============================================================================

BEGIN;

-- `anon`/`authenticated` solo existen en un proyecto Supabase (los crea
-- PostgREST) -- en un Postgres local liso (como la base de pruebas de este
-- repo) no existen, y REVOKE FROM de un rol inexistente aborta la
-- transacción. Este bloque revoca de cada uno solo si existe, para que la
-- misma migración corra igual en producción (Supabase) y en local/CI.
DO $$
DECLARE
  vw text;
  role_name text;
BEGIN
  FOREACH vw IN ARRAY ARRAY[
    'public.v_metrics_by_role_vector',
    'public.v_fall_reason_breakdown',
    'public.v_falls_by_team',
    'public.v_team_summary'
  ] LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', vw);
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON %s FROM %I', vw, role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;

ALTER VIEW public.v_metrics_by_role_vector SET (security_invoker = true);
ALTER VIEW public.v_fall_reason_breakdown  SET (security_invoker = true);
ALTER VIEW public.v_falls_by_team          SET (security_invoker = true);
ALTER VIEW public.v_team_summary           SET (security_invoker = true);

-- Explícito y auto-documentado, aunque app_service ya tenía acceso directo
-- por ser dueño/rol con privilegios amplios sobre el esquema. En local/CI
-- el rol de conexión no se llama "app_service" (ver DATABASE_URL de cada
-- entorno), así que este GRANT se salta ahí sin fallar la migración.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_service') THEN
    GRANT SELECT ON public.v_metrics_by_role_vector TO app_service;
    GRANT SELECT ON public.v_fall_reason_breakdown  TO app_service;
    GRANT SELECT ON public.v_falls_by_team          TO app_service;
    GRANT SELECT ON public.v_team_summary           TO app_service;
  END IF;
END $$;

COMMIT;
