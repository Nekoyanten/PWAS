-- ============================================================================
-- Migración 010 — Interacción ampliada: tableros reales, chat persistente,
-- correos/chat conversacionales con árbol de respuestas, credenciales de
-- práctica (TG §8.2.1, ampliación acordada el 9 de septiembre sobre
-- docs/2026-09-09_diversificacion-vectores-ataque.md).
-- Aplica sobre una base que ya tiene las migraciones 001-009.
-- Ejecutar:  psql "$DATABASE_URL" -f db/migrations/010_interaccion_ampliada.sql
--
-- Decisiones de diseño (confirmadas con el equipo antes de escribir esto):
--   1. Árbol de respuestas con plantillas prediseñadas (opción "a"), NO un
--      chatbot que interprete texto libre con IA -- cada rama es una fila en
--      message_branches que el admin define de antemano. Reproducible y
--      auditable, igual que el resto del sistema.
--   2. El "responsable" de una tarea del tablero es un compañero FICTICIO
--      con nombre realista (fictitious_contacts), elegido de una lista --
--      nunca texto libre. Cero PII de terceros: es el mismo principio que ya
--      aplicaba a la marca TaskFlow (PS §3.2), extendido a los "compañeros".
--   3. Las credenciales de práctica que el equipo le asigna a cada
--      participante (participant_campaign.practice_username/password) NO son
--      las credenciales reales de nadie -- son un usuario/contraseña
--      inventados para el ejercicio. Aun así, la comparación contra lo que el
--      participante escribe se hace en memoria en el backend y se descarta
--      igual que hoy: solo se guarda el resultado (deliveries.
--      credential_match_result), nunca el texto escrito. Esto no es
--      desconfianza hacia el diseño del equipo -- es la misma razón por la
--      que schema.sql ya descarta cualquier payload de formulario: una
--      persona bajo presión a veces escribe su contraseña real por costumbre
--      aunque se le haya dado una de práctica, y el sistema no debe poder
--      guardar eso ni por accidente.
-- ============================================================================

BEGIN;

-- message_kind: 'chat' se suma a 'email'/'task' -- un mensaje de ataque
-- entregado dentro del hilo de chat persistente (chat_messages.kind='attack',
-- delivery_id apuntando a la fila de deliveries de siempre) en vez de la
-- bandeja. Toda la telemetría existente (eventos, jolting, motor de riesgo)
-- sigue funcionando sin cambios porque sigue siendo un delivery normal.
ALTER TYPE message_kind ADD VALUE IF NOT EXISTS 'chat';

-- Nuevo evento: el participante contestó (una rama de correo/chat, o un
-- mensaje libre en el chat). Distinto de 'intento_envio' (que es "se envió
-- un formulario") y de 'clic' (que es "se abrió el estímulo").
ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'respuesta_participante';

COMMIT;

-- Los ALTER TYPE ... ADD VALUE de arriba no pueden usarse en la misma
-- transacción en la que se insertan datos con ese valor nuevo (regla de
-- Postgres); por eso todo lo que sigue va en una transacción aparte.
BEGIN;

-- ----------------------------------------------------------------------------
-- Compañeros de equipo FICTICIOS (nunca personas reales) -- catálogo por
-- campaña, reusado en dos lugares: como remitente dentro del hilo de chat y
-- como "responsable" asignable de una tarea del tablero. Un solo catálogo
-- para ambos usos evita mantener dos listas de nombres inventados que
-- podrían desincronizarse (ej. "Andrea Gómez" apareciendo en el chat con una
-- cara y en el tablero con otra).
CREATE TABLE fictitious_contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL,
  role_label    TEXT,
  avatar_color  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_fictitious_contacts_campaign ON fictitious_contacts(campaign_id);
COMMENT ON TABLE fictitious_contacts IS
  'Compañeros de equipo inventados por el admin (nombre realista, nadie real detrás) -- PS §3.2 extendido: ni la marca TaskFlow ni sus "empleados" corresponden a personas u organizaciones reales. Reusado como remitente de chat y como responsable de tarea.';

-- ----------------------------------------------------------------------------
-- Tableros reales del participante (antes: un único tablero de ejemplo,
-- estado solo en localStorage, invisible para el equipo de investigación).
-- Un participante puede crear varios ("Desarrollo de aplicativo verde",
-- "Marketing digital", ...). Cada tablero nace con 3 columnas estándar
-- (Por hacer / En curso / Hecho) -- no se ofrece crear columnas a medida
-- todavía, para no disparar el alcance; ver docs para la nota de extensión
-- futura.
CREATE TABLE boards (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_campaign_id UUID NOT NULL REFERENCES participant_campaign(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_boards_pc ON boards(participant_campaign_id);

CREATE TABLE board_columns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id    UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_board_columns_board ON board_columns(board_id);

CREATE TABLE board_tasks (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  column_id              UUID NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  title                  TEXT NOT NULL,
  description            TEXT,
  responsible_contact_id UUID REFERENCES fictitious_contacts(id),
  position               INTEGER NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_board_tasks_column ON board_tasks(column_id);
COMMENT ON COLUMN board_tasks.responsible_contact_id IS
  'Compañero ficticio asignado como responsable (fictitious_contacts) -- se elige de una lista, nunca texto libre. NULL = sin asignar.';

-- Plantilla de tablero que el admin diseña de antemano para una campaña
-- (ej. "Desarrollo de aplicativo verde" con columnas y tareas semilla ya
-- escritas). `seed` es la estructura completa a clonar la primera vez que un
-- participante crea un tablero a partir de esta plantilla:
--   [{ "name": "Por hacer", "tasks": [{ "title": "...", "description": "...",
--      "responsible_contact_id": "<uuid o null>" }, ...] }, ...]
-- Igual que landing_config en templates, se usa JSONB en vez de tablas
-- *_template_columns/*_template_tasks aparte para no multiplicar tablas por
-- algo que es, en esencia, configuración de semilla.
CREATE TABLE board_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  seed         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_board_templates_campaign ON board_templates(campaign_id);
COMMENT ON COLUMN board_templates.seed IS
  'Columnas y tareas semilla a clonar al instanciar el tablero para un participante. Ver POST /t/:token/boards {template_id}.';

-- ----------------------------------------------------------------------------
-- Chat persistente por participante -- un hilo por participant_campaign,
-- creado (instanciado desde un chat_script_templates si la campaña tiene
-- uno) la primera vez que el participante abre la vista de chat.
CREATE TABLE chat_threads (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_campaign_id UUID NOT NULL UNIQUE REFERENCES participant_campaign(id) ON DELETE CASCADE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guion de conversación ambiente que el admin escribe de antemano para una
-- campaña -- una lista ordenada de pasos, cada uno "scripted" (un compañero
-- ficticio dice algo) o "attack" (en ese punto del hilo se inyecta un
-- mensaje de ataque, creado a partir de template_id igual que cualquier
-- delivery). Formato de `script`:
--   [{ "type": "scripted", "sender_contact_id": "<uuid>", "body": "..." },
--    { "type": "attack", "template_id": "<uuid>" }, ...]
CREATE TABLE chat_script_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  script       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_script_templates_campaign ON chat_script_templates(campaign_id);

-- Mensajes concretos de un hilo, ya instanciados para un participante.
--   kind='scripted' -> body tiene el texto fijo escrito por el admin.
--   kind='attack'   -> body es NULL; el contenido real vive en messages/
--                      deliveries (delivery_id), igual que un ataque de
--                      correo -- así reusa TODA la telemetría existente
--                      (eventos, jolting, motor de riesgo) sin duplicar nada.
--   kind='reply'    -> body es lo que el participante escribió. Es la única
--                      excepción nueva a "nunca se guarda lo que el
--                      participante escribe": es necesaria para que el hilo
--                      se pueda seguir mostrando igual al recargar la
--                      página. No es información sensible por sí misma (es
--                      una conversación de chat de trabajo, no una
--                      contraseña) pero sí es un cambio real de postura
--                      frente al resto del sistema -- ver docs.
CREATE TABLE chat_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_thread_id    UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender_contact_id UUID REFERENCES fictitious_contacts(id),
  kind              TEXT NOT NULL CHECK (kind IN ('scripted','attack','reply')),
  body              TEXT,
  delivery_id       UUID REFERENCES deliveries(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_messages_thread ON chat_messages(chat_thread_id, position);
COMMENT ON COLUMN chat_messages.sender_contact_id IS
  'NULL cuando el mensaje lo escribió el propio participante (kind=reply). Para kind=scripted/attack es el compañero ficticio remitente.';

-- ----------------------------------------------------------------------------
-- Árbol de respuestas (opción "a" acordada): desde una plantilla de ataque,
-- qué acciones rápidas puede tomar el participante y a qué otra plantilla
-- lleva cada una. Sirve tanto para correo como para chat, porque ambos son
-- filas de `messages`. Sin fila en esta tabla para un template_id => ese
-- mensaje no ofrece respuesta rápida (comportamiento de hoy, sin cambios).
CREATE TABLE message_branches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  action_key       TEXT NOT NULL,
  action_label     TEXT NOT NULL,
  to_template_id   UUID NOT NULL REFERENCES templates(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_template_id, action_key)
);
COMMENT ON TABLE message_branches IS
  'Árbol de respuestas prediseñado (no IA generativa): desde el template de un mensaje, qué botones de respuesta rápida se ofrecen y a qué template siguiente lleva cada uno.';

-- El mensaje/delivery concreto que resultó de seguir una rama, para poder
-- reconstruir la conversación (a qué respondió, con qué acción).
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS parent_message_id UUID REFERENCES messages(id),
  ADD COLUMN IF NOT EXISTS branch_action_key TEXT;
COMMENT ON COLUMN messages.parent_message_id IS
  'Mensaje del que este es la continuación (se llegó aquí siguiendo una rama de message_branches). NULL = mensaje raíz de la conversación.';

-- ----------------------------------------------------------------------------
-- Credenciales de práctica asignadas por el equipo a cada participante para
-- este ejercicio (NO son las credenciales reales de nadie). Nacen NULL: solo
-- se completan si el equipo decide usar el formato de captura de
-- credenciales para esa campaña.
ALTER TABLE participant_campaign
  ADD COLUMN IF NOT EXISTS practice_username TEXT,
  ADD COLUMN IF NOT EXISTS practice_password TEXT;
COMMENT ON COLUMN participant_campaign.practice_username IS
  'Usuario de práctica asignado por el equipo para este ejercicio -- no es una credencial real de nadie.';
COMMENT ON COLUMN participant_campaign.practice_password IS
  'Contraseña de práctica asignada por el equipo -- ídem. Se usa solo para comparar en memoria contra lo que el participante escriba en una landing de credenciales; ver deliveries.credential_match_result.';

-- Resultado de comparar (en memoria, sin persistir el texto) lo escrito en
-- una landing de credenciales contra las de práctica de ese participante.
-- NULL = no aplica (no era un envío de credenciales, o no había
-- practice_username/password asignados con qué comparar).
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS credential_match_result BOOLEAN;
COMMENT ON COLUMN deliveries.credential_match_result IS
  'TRUE/FALSE si lo enviado en la landing de credenciales coincidió con participant_campaign.practice_username/password -- calculado en memoria, el texto escrito nunca se guarda (mismo principio que intento_envio).';

COMMIT;
