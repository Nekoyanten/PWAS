-- ============================================================================
-- Migración 009 — Endurecimiento de RLS: sin acceso anónimo vía PostgREST
-- Aplica sobre una base que ya tiene las migraciones 001-008.
-- Ejecutar:  psql "$DATABASE_URL" -f db/migrations/009_rls_hardening_no_anon_access.sql
--
-- Contexto: esta migración documenta en el repo un cambio que ya se aplicó
-- directamente contra el proyecto de Supabase de producción (ihemxqzuolhmkwikhnlg)
-- el 9 de septiembre, como parte de la auditoría de preparación para el
-- piloto real -- se escribe acá ahora para que quede en el historial de
-- migraciones y no se pierda si algún día se reconstruye la base desde cero.
--
-- Motivo: el linter de seguridad de Supabase marcó las 12 tablas de public
-- como expuestas por la API REST autogenerada (PostgREST) sin Row Level
-- Security. En la práctica, cualquiera con la anon key pública del proyecto
-- podía leer o escribir participantes, mensajes, deliveries, eventos
-- conductuales y encuestas directamente, sin pasar por la app Express ni su
-- autenticación. La app (apps/api, vía DATABASE_URL) se conecta como el rol
-- `postgres`, que tiene BYPASSRLS = true (confirmado contra pg_roles) --
-- activar RLS sin políticas no le cambia nada a la app: sigue viendo todo
-- igual. Lo único que cambia es que los roles `anon`/`authenticated` (los
-- que usa PostgREST) dejan de poder tocar estas tablas, porque no se define
-- ninguna policy -- deny por defecto. La app nunca ha usado la API REST de
-- Supabase (usa `pg` con connection string directa, ver apps/api/src/db.js),
-- así que no hay ninguna funcionalidad real que dependa de ese acceso.
-- ============================================================================

BEGIN;

ALTER TABLE public.templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participant_campaign ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.behavior_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.behavior_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_session_survey ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.behavior_session_features ENABLE ROW LEVEL SECURITY;

COMMIT;
