-- ============================================================================
-- Migración 012 — RLS en las 9 tablas nuevas de la migración 010
-- Aplica sobre una base que ya tiene las migraciones 001-011.
-- Ejecutar:  psql "$DATABASE_URL" -f db/migrations/012_rls_tablas_interaccion_ampliada.sql
--
-- Contexto: esta migración documenta en el repo un cambio ya aplicado
-- directamente contra el proyecto de Supabase de producción
-- (ihemxqzuolhmkwikhnlg) el 10 de septiembre, mientras se diagnosticaba y
-- corregía por qué el piloto real devolvía errores (ver
-- docs/2026-09-10_fix-rls-app-service-y-crash-async.md y la migración 011).
--
-- Motivo: al aplicar recién la migración 010 en producción (nunca se había
-- corrido ahí -- ese era, de hecho, el motivo del HTTP 500 al abrir un
-- enlace de participante: `column pc.practice_username does not exist`),
-- el linter de seguridad de Supabase marcó sus 9 tablas nuevas
-- (fictitious_contacts, boards, board_columns, board_tasks,
-- board_templates, chat_threads, chat_script_templates, chat_messages,
-- message_branches) como expuestas por la API REST autogenerada
-- (PostgREST) SIN Row Level Security -- el mismo hueco que la migración 009
-- ya había cerrado para las 12 tablas originales, reabierto sin querer
-- porque la 010 se escribió y probó en un momento en que RLS todavía no
-- formaba parte del checklist de cada tabla nueva.
--
-- Como la migración 011 ya le dio BYPASSRLS al rol `app_service` que usa la
-- app, activar RLS acá no le cambia nada a la app (sigue viendo todo
-- igual, igual que con las 12 tablas originales) -- solo bloquea a
-- `anon`/`authenticated` (los roles de PostgREST) sin ninguna policy
-- definida, deny por defecto.
-- ============================================================================

BEGIN;

ALTER TABLE public.fictitious_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.board_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.board_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.board_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_script_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_branches ENABLE ROW LEVEL SECURITY;

COMMIT;
