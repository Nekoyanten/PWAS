-- ============================================================================
-- Migración 013 — Prioridad y checklist reales en board_tasks
-- Aplica sobre una base que ya tiene las migraciones 001-012.
-- Ejecutar:  psql "$DATABASE_URL" -f db/migrations/013_prioridad_checklist_tareas.sql
--
-- Contexto: al integrar el prototipo visual "TaskFlow colaborativa" (tablero
-- Kanban con prioridad por tarjeta y checklist), se decidió con el usuario
-- que esas dos cosas queden persistidas de verdad -- no solo de adorno en la
-- UI -- para que "funcione realmente bien". board_tasks no tenía ninguna de
-- las dos columnas.
--
-- priority: un CHECK en vez de un ENUM nuevo (como landing_kind/message_kind)
-- porque son solo 3 valores fijos, de uso exclusivo de esta tabla, y evita
-- tener que tocar el tipo después si algún día se agrega/renombra un nivel
-- (un ENUM en Postgres no se achica fácil; un CHECK sí se reemplaza con un
-- ALTER TABLE simple).
--
-- checklist: JSONB en vez de una tabla aparte (board_task_checklist_items),
-- siguiendo el mismo patrón ya usado en este proyecto para listas chicas y
-- de forma variable por fila (landing_config, board_templates.seed,
-- chat_script_templates.script): un arreglo de
-- {"title": "...", "done": true|false}, sin límite de tamaño práctico para
-- una checklist de tarjeta y sin necesitar JOINs ni RLS aparte -- ya hereda
-- el RLS de board_tasks (migración 012).
-- ============================================================================

BEGIN;

ALTER TABLE board_tasks
  ADD COLUMN priority TEXT NOT NULL DEFAULT 'media'
    CHECK (priority IN ('alta', 'media', 'baja'));

ALTER TABLE board_tasks
  ADD COLUMN checklist JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN board_tasks.priority IS
  'Prioridad visible en la tarjeta del tablero. Solo 3 niveles fijos -- ver comentario de la migración.';
COMMENT ON COLUMN board_tasks.checklist IS
  'Lista de sub-ítems de la tarjeta: [{"title": "...", "done": bool}, ...]. Se reemplaza entera en cada guardado (igual que landing_config), no hay endpoint por ítem individual.';

COMMIT;
