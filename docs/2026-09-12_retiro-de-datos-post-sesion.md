# Retiro de datos post-sesión

**Fecha:** 12 de septiembre de 2026
**Disparador:** hallazgo 4.2 del informe de revisión crítica de la tesis (v2, §9.1) — "la participación es voluntaria, informada y revocable en cualquier momento sin consecuencia alguna" solo era cierto *durante* la sesión (dejar de marcar la casilla de consentimiento, o cerrar la pestaña). No existía ninguna forma de que un participante pidiera el borrado de sus datos después de que la sesión ya había terminado — la promesa del texto y lo que el sistema realmente permitía hacer ya no coincidían.

## 1. Qué se agregó

- `apps/api/src/lib/withdrawal.js` (nuevo): `withdrawParticipantData(participantCampaignId, participantId)`.
- `apps/api/src/lib/decoy.js`: dos pantallas nuevas, `renderWithdrawConfirm(token)` y `renderWithdrawn()`, y `renderDebrief()` ahora recibe también `token`/`origin` para mostrar el enlace de retiro.
- `apps/api/src/routes/tracking.js`: `GET /t/:token/withdraw` (confirmación) y `POST /t/:token/withdraw` (borrado real).
- `apps/api/tests/integration/withdrawal.test.js` (nuevo): 4 pruebas de integración contra Postgres real.

## 2. El mecanismo: un DELETE, no una lista de tablas

`participant_campaign` es la fila "cabecera" de una sesión. Todas las tablas de datos de sesión ya tenían `participant_campaign_id ... ON DELETE CASCADE` hacia ella, por razones ajenas a este cambio (limpieza de pruebas, el endpoint de "reset" del admin): `deliveries`, `events`, `post_session_survey`, `behavior_sessions` → `behavior_events`, `facial_sessions` → `facial_events`, `boards` → `board_columns` → `board_tasks`, `chat_threads` → `chat_messages` (ver `db/schema.sql` y las migraciones 004, 008, 010, 015).

Por eso `withdrawParticipantData` no enumera tablas: un solo `DELETE FROM participant_campaign WHERE id = $1` arrastra todo lo anterior en cascada. Después de ese DELETE, si la fila de `participants` (el identificador pseudónimo — `external_hash`, `role`, `team_label`, `group_assignment`, `camera_consent_given`) no tiene ninguna otra `participant_campaign` que la referencie, también se borra: no tiene sentido dejar un identificador pseudónimo huérfano, sin ninguna sesión detrás. Si el mismo participante (mismo `external_hash`, y por tanto el mismo `participant_id`) sigue teniendo otra campaña activa, esa fila de identidad se conserva porque todavía hace falta — verificado en la prueba "si el participante tiene OTRA campaña, retirarse de una no borra su fila de participants".

## 3. La UX: confirmar antes de borrar, y un enlace que sobrevive a la pestaña cerrada

El borrado es permanente y de un solo sentido, así que `GET /t/:token/withdraw` solo muestra una pantalla de confirmación explícita — no dispara nada. El botón de esa pantalla hace el `POST` real.

El enlace de retiro se muestra una sola vez, al final de la sesión, en la pantalla de debriefing (`renderDebrief`). Se construye como URL **absoluta** (`${req.protocol}://${req.get("host")}/t/:token/withdraw`), no relativa como el resto de los enlaces del flujo del participante: todos los demás enlaces se siguen de inmediato, dentro de la misma navegación, así que una ruta relativa les basta. Este es distinto — el participante puede cerrar la pestaña hoy y decidir usar el enlace días o semanas después, desde otra pestaña o dispositivo, así que necesita la URL completa para que siga funcionando fuera del contexto de esa sesión de navegación.

Después del borrado, el propio token deja de resolver a ningún `participant_campaign` (la fila que `loadPC()` busca ya no existe), así que **cualquier** ruta bajo `/t/:token/...` responde con la pantalla de "enlace no válido" — no hace falta invalidar el token por separado. Pedir el retiro dos veces con el mismo enlace es 404 la segunda vez, no un error 500: `loadPC` simplemente no encuentra nada que borrar.

## 4. Qué NO hace (todavía)

- No es anonimización parcial ni "soft delete": es borrado real de las filas. No hay una opción intermedia de "conservar los datos pero desvincularlos del participante" — se decidió así porque el pseudónimo (`external_hash`) ya es la única conexión con la identidad real, y una vez borrado no queda nada que desvincular.
- No envía ninguna notificación ni confirmación por otro canal (correo, etc.) — el sistema no tiene ni debe tener un canal de contacto real con el participante (ver la nota de no-PII en `db/schema.sql`); la única confirmación es la pantalla que ve en el momento.
- El enlace de retiro no tiene fecha de expiración propia — sigue siendo válido mientras la fila de `participant_campaign` exista, igual que el resto de los enlaces `/t/:token/...` de este sistema.

## 5. Verificación

`apps/api/tests/integration/withdrawal.test.js` puebla, para un participante real (consentimiento + consentimiento de cámara, calibración completada), datos genuinos en cada tabla que el mecanismo dice cubrir: una sesión conductual con eventos de mouse/teclado, una sesión facial con una muestra, una respuesta a la encuesta post-sesión, un tablero con una columna y una tarea, un hilo de chat con un mensaje, y un delivery+evento de un mensaje real. Después:

1. confirma que `GET /withdraw` no borra nada;
2. confirma que `POST /withdraw` deja en cero **cada una** de esas tablas (no solo `participant_campaign`) y borra la fila de `participants` huérfana;
3. confirma que el token deja de resolver en cualquier ruta después, y que pedir el retiro una segunda vez es 404;
4. confirma que si el mismo participante tiene otra campaña activa, su fila de `participants` sobrevive al retiro de la primera.

Suite completa verificada en verde: **130/130** (126 previas + las 4 nuevas de este archivo), corridas contra Postgres local (`paws_test`).

## 6. Relación con el texto de la tesis

TG §9.1 pasa de prometer que la participación es "revocable en cualquier momento sin consecuencia alguna" a describir, además, el mecanismo real por el cual eso se ejerce después de que la sesión terminó: el enlace de retiro en la pantalla de debriefing y el flujo de confirmación descrito arriba (ver v2.4 del documento).
