-- ============================================================================
-- Migración 006 — Intervención (jolting) adaptativa, no determinista
-- Aplica sobre una base que ya tiene las migraciones 001-005.
-- Ejecutar:  psql "$DATABASE_URL" -f db/migrations/006_jolting_adaptativo.sql
--
-- Motivo: hasta ahora el aviso "Espera un momento antes de continuar"
-- (tracking.js, GET /:token/d/:deliveryId/go) salía SIEMPRE para el 100% del
-- grupo experimental y NUNCA para el control — cero variación dentro del
-- grupo experimental. Con ese diseño, lo que el sistema mide no es "¿la
-- persona reconoce y cae en un ataque de phishing en condiciones realistas?"
-- sino "¿la persona ignora una advertencia explícita que ya le mostramos?" —
-- dos preguntas de investigación distintas, y la segunda no permite evaluar
-- lo que dicen los documentos de la tesis sobre susceptibilidad real, porque
-- el propio aviso se convierte en la señal, no el comportamiento espontáneo.
--
-- Esta migración agrega el mecanismo para que la intervención sea adaptativa:
--   1. `messages.jolting_enabled` (por mensaje de ataque): interruptor
--      binario de si ESTE mensaje puede alguna vez mostrar el aviso. Un
--      mensaje con jolting_enabled = FALSE nunca lo muestra a nadie, sin
--      importar el grupo — cubre el caso "necesito poder enviar el ataque
--      sin que salga ningún mensaje".
--   2. `campaigns.jolting_probability` (por campaña): probabilidad, entre 0
--      y 1, de que un ENVÍO concreto de un mensaje con jolting_enabled=TRUE
--      efectivamente muestre el aviso al grupo experimental. En vez de
--      "siempre" (1.0) o "nunca" (0.0), el admin puede fijar p.ej. 0.4 para
--      que salga en ~40% de los envíos — variabilidad real, medible.
--   3. `deliveries.jolting_roll`: el resultado de esa probabilidad, fijado
--      UNA sola vez por envío en el momento de crear el delivery (no en cada
--      clic) usando el mismo PRNG sembrado y determinista que ya usa
--      assignBalanced() (lib/rng.js: hash32 + mulberry32) sobre
--      `seed de la campaña + id del mensaje + id del participant_campaign`.
--      Guardarlo así — en vez de tirar el dado en cada visita al enlace —
--      evita el bug de que reabrir el mismo enlace "vuelva a sortear" el
--      resultado, y hace el experimento reproducible y auditable: con la
--      misma semilla, el mismo conjunto de envíos siempre da el mismo
--      patrón de quién vio o no el aviso.
--
-- Compatibilidad con datos existentes (deliberada, no accidental):
--   - `jolting_probability` nace en 1.000 (100%) para toda campaña ya
--     existente: el comportamiento de campañas en curso o ya corridas NO
--     cambia con solo aplicar esta migración. Es responsabilidad del admin
--     bajar la probabilidad para campañas nuevas donde quiera medir esto.
--   - `jolting_enabled` nace en TRUE para todo mensaje ya existente: ningún
--     mensaje de ataque pasa a "silencioso" por accidente.
--   - `jolting_roll` nace en TRUE para todo delivery ya existente (mismo
--     razonamiento: con probabilidad 1.0 el sorteo siempre daba TRUE, así
--     que fijarlo en TRUE para lo ya entregado es exactamente lo que ya
--     habría pasado). Los deliveries NUEVOS lo calculan explícitamente al
--     insertarse (ver POST /messages/:id/send en messages.js) — el DEFAULT
--     de la columna es solo la red de seguridad para cualquier INSERT que
--     no lo especifique.
-- ============================================================================

BEGIN;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS jolting_probability NUMERIC(4,3) NOT NULL DEFAULT 1.000
    CONSTRAINT jolting_probability_range CHECK (jolting_probability >= 0 AND jolting_probability <= 1);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS jolting_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS jolting_roll BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN campaigns.jolting_probability IS
  'Probabilidad (0..1) de que un envío de un mensaje con jolting_enabled=TRUE muestre el aviso "Espera un momento..." al grupo experimental. 1.0 = siempre (comportamiento previo a esta migración). No afecta al grupo control, que nunca lo ve.';
COMMENT ON COLUMN messages.jolting_enabled IS
  'Si es FALSE, este mensaje de ataque NUNCA muestra el aviso, para ningún participante ni grupo — permite enviar un ataque "silencioso" a propósito.';
COMMENT ON COLUMN deliveries.jolting_roll IS
  'Resultado (fijo, calculado una sola vez al crear el delivery) del sorteo de probabilidad contra campaigns.jolting_probability, sembrado con el seed de la campaña + message_id + participant_campaign_id. Ver POST /messages/:id/send en messages.js. Junto con messages.jolting_enabled y group_assignment=''experimental'' decide si tracking.js muestra la intervención.';

COMMIT;
