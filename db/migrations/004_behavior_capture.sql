-- ============================================================================
-- Migración 004 — Captura conductual real (Tabla 1 §8.2.1, fila 1)
-- Aplica sobre una base que ya tiene las migraciones 001-003.
-- Ejecutar:  psql "$DATABASE_URL" -f db/migrations/004_behavior_capture.sql
--
-- Motivo: hasta ahora el sistema solo registraba eventos GRUESOS de negocio
-- (abierto/clic/intento_envio/…, tabla `events`, un evento por acción). La
-- Tabla 1 pide además la CAPTURA CONDUCTUAL cruda de mouse/teclado — la
-- materia prima de la que el Módulo 2 (preprocesamiento) y el Módulo 3
-- (representación: AUC/SE/MD, latencias de tecleo) del pipeline de ML
-- calculan sus features. Esta migración agrega SOLO el almacenamiento de esa
-- materia prima; el preprocesamiento y la inferencia siguen siendo un
-- workstream de Python aparte (fuera del alcance de este repo Node/Express).
--
-- Diseño elegido y por qué:
--   * Dos tablas, no una: `behavior_sessions` (una fila por "página" donde el
--     participante estuvo activo — el tablero de TaskFlow, un mensaje
--     abierto, la landing de un ataque, la encuesta) y `behavior_events`
--     (una fila por muestra cruda dentro de esa sesión). Separar sesión de
--     evento evita repetir viewport/fase/participante en cada una de las
--     miles de muestras por sesión.
--   * `behavior_sessions.id` lo genera el NAVEGADOR (`crypto.randomUUID()`),
--     no el servidor: así el cliente puede referenciar su propia sesión en
--     cada lote sin una ida y vuelta previa para pedir un id, y reintentar
--     lotes sin duplicar la sesión (INSERT ... ON CONFLICT DO NOTHING).
--   * `t_ms` es un entero relativo (ms desde `behavior_sessions.started_at`),
--     no un TIMESTAMPTZ por muestra: ocupa menos espacio, evita depender del
--     reloj del navegador del participante para el orden temporal, y es
--     exactamente el formato que la literatura de dinámica de mouse/tecleo
--     usa para calcular velocidad/aceleración/latencias.
--   * NUNCA se guarda el carácter tecleado (`event.key` / el valor de un
--     input) — solo `key_code` (`event.code`, la tecla FÍSICA: 'KeyA',
--     'Backspace', 'Enter'...). Esto no es una elección nueva: ya es un
--     invariante del proyecto ("Ninguna pantalla captura contenido escrito
--     por el participante", ver cabecera de apps/api/src/lib/decoy.js) —
--     esta migración solo lo hace cumplir también a nivel de esquema, sin
--     una sola columna donde un texto escrito pudiera terminar guardado.
-- ============================================================================

BEGIN;

DO $$ BEGIN
  CREATE TYPE behavior_event_type AS ENUM (
    'mousemove', 'mousedown', 'mouseup', 'click',
    'keydown', 'keyup',
    'visibility_hidden', 'visibility_visible'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Una fila por carga de página con captura activa (tablero, mensaje, landing
-- de ataque, encuesta). `phase` identifica cuál, para poder filtrar/agrupar
-- en el análisis (p.ej. "solo el momento de exposición al ataque").
CREATE TABLE IF NOT EXISTS behavior_sessions (
  id                       UUID PRIMARY KEY,
  participant_campaign_id  UUID NOT NULL REFERENCES participant_campaign(id) ON DELETE CASCADE,
  delivery_id              UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  phase                    TEXT NOT NULL,
  started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_flush_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  viewport_w               SMALLINT,
  viewport_h               SMALLINT,
  sample_count             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_behavior_sessions_pc       ON behavior_sessions(participant_campaign_id);
CREATE INDEX IF NOT EXISTS idx_behavior_sessions_delivery ON behavior_sessions(delivery_id);

-- Una fila por muestra cruda. BIGSERIAL porque el volumen esperado es mucho
-- mayor que el de `events` (miles de mousemove por sesión, no decenas).
CREATE TABLE IF NOT EXISTS behavior_events (
  id                  BIGSERIAL PRIMARY KEY,
  behavior_session_id UUID NOT NULL REFERENCES behavior_sessions(id) ON DELETE CASCADE,
  t_ms                INTEGER NOT NULL,
  event_type          behavior_event_type NOT NULL,
  x                   SMALLINT,   -- coordenadas relativas al viewport; NULL en keydown/keyup/visibility_*
  y                   SMALLINT,
  key_code            TEXT        -- SOLO event.code (tecla física). NUNCA event.key ni el valor de un input.
);
CREATE INDEX IF NOT EXISTS idx_behavior_events_session_t ON behavior_events(behavior_session_id, t_ms);

COMMIT;
