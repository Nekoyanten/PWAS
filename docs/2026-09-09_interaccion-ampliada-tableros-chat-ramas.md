# Interacción ampliada: tableros reales, chat simulado y árbol de respuestas (migración 010)

Fecha: 2026-09-09. Responde a la petición del usuario de "hacer un trabajo
más completo" sobre tres puntos concretos que ya existían solo a medias o no
existían: (1) un chat simulado donde "el equipo de trabajo" le escribe al
participante y por donde también llegan ataques; (2) tableros Kanban que el
participante pueda de verdad **crear y llenar** (no solo arrastrar tarjetas
de ejemplo), con tareas asignadas a un responsable; (3) que los ataques
—de correo o de chat— se puedan **contestar**, y que la respuesta lleve a
otro mensaje distinto según lo que el participante elija, simulando una
conversación de ingeniería social con más de un paso. Incluye además el
mecanismo de credenciales de práctica que hace posible medir "cayó en el
robo de credenciales" sin que eso implique guardar ninguna contraseña real
de nadie.

## 1. Punto de partida y dos decisiones que tomó el usuario

Antes de tocar código se revisó qué existía: la vista "Mi tablero" del
señuelo TaskFlow (`lib/decoy.js`, componente Alpine `tfBoard()`) ya tenía
alta/edición/borrado/arrastre de tarjetas — pero el estado vivía **solo en
`localStorage` del navegador**. Nunca llegaba al servidor: el equipo de
investigación no podía verlo, no existían varios tableros, y no había forma
de que un ataque referenciara una tarea real del participante como pretexto.
El "chat" y el "contestar un correo" no existían en ninguna forma.

Dos puntos quedaban deliberadamente abiertos para que los resolviera el
usuario, no el diseño técnico, porque tocan el protocolo del estudio y no
solo la implementación:

- **¿Cómo se decide qué responde el sistema cuando el participante contesta
  un ataque?** Opción (a): un árbol de decisión prediseñado por el
  investigador (un catálogo cerrado de plantillas encadenadas). Opción (b):
  interpretar el texto libre del participante con un modelo generativo en
  vivo. El usuario eligió **(a)** ("vamos por la opción a, el árbol de
  respuestas"). Esto es lo que se construyó: nada de este módulo interpreta
  lenguaje natural; toda ramificación es una fila que el admin creó de
  antemano en `message_branches`.
- **¿Quién puede ser "responsable" de una tarea?** El esquema del proyecto
  tiene como regla no negociable (`schema.sql`) no guardar PII de nadie —
  ni del participante ni de terceros. Poner un campo de texto libre para
  "responsable" habría sido una puerta lateral para que apareciera el
  nombre real de un compañero de trabajo de verdad. El usuario confirmó por
  la vía de la pregunta guiada: **compañeros ficticios con nombre
  realista, elegidos de una lista** (nunca texto libre). Así quedó
  implementado: `fictitious_contacts` es un catálogo cerrado por campaña, y
  el `<select>` del formulario de tarea es la única forma de asignar un
  responsable.

Sobre las credenciales: el usuario aclaró que son credenciales de
**práctica**, entregadas por el equipo de investigación a cada participante
para este ejercicio — nunca las credenciales reales de la persona. Aun así
se mantuvo el principio ya existente del proyecto de "nunca persistir lo que
el participante escribió": la comparación se hace en memoria contra la
credencial de práctica asignada, y solo se guarda si coincidió o no
(booleano), nunca el texto.

## 2. Migración `010_interaccion_ampliada.sql`

- `message_kind` gana el valor `'chat'` (antes solo `email`/`task`);
  `event_type` gana `'respuesta_participante'`. Cada `ALTER TYPE ADD VALUE`
  va en su propia sentencia porque Postgres no permite usar un valor de enum
  nuevo en la misma transacción que lo agrega.
- `fictitious_contacts(id, campaign_id, display_name, role_label,
  avatar_color)`: el catálogo cerrado de compañeros ficticios por campaña.
- `boards`, `board_columns`, `board_tasks`: el tablero real del
  participante. `board_tasks.responsible_contact_id` referencia
  `fictitious_contacts` (nulo permitido, sin cascada: borrar un contacto en
  uso falla, no arrastra silenciosamente las tareas que lo usaban — ver
  `DELETE /api/contacts/:id` más abajo).
- `board_templates(id, campaign_id, name, seed jsonb)`: plantillas de
  tablero que el investigador diseña de antemano — el `seed` es
  `[{name, tasks:[{title, description, responsible_contact_id}]}]` — para
  los casos como los del ejemplo del usuario ("Desarrollo de aplicativo
  verde", "Marketing digital"): el participante elige la plantilla al crear
  su tablero y el sistema clona sus columnas y tareas semilla.
- `chat_threads(participant_campaign_id UNIQUE)`: un hilo por participante.
- `chat_script_templates(id, campaign_id, name, script jsonb)`: el guion de
  chat que el investigador prepara — una lista ordenada de pasos
  `{type:'scripted', sender_contact_id, body}` (lo que ya "dijo" un
  compañero ficticio) o `{type:'attack', template_id, sender_contact_id}`
  (un ataque real que se inyecta en la conversación).
- `chat_messages(chat_thread_id, sender_contact_id, kind, body,
  delivery_id, position)`: `kind` es `scripted` | `attack` | `reply`. Un
  mensaje de ataque no guarda su contenido aquí — se enlaza por
  `delivery_id` a la fila real en `messages`/`deliveries`, así toda la
  telemetría existente (eventos, jolting, riesgo) sigue funcionando sin
  cambios para un ataque que llegó por chat en vez de por correo.
- `message_branches(from_template_id, action_key, action_label,
  to_template_id, UNIQUE(from_template_id, action_key))`: el árbol de
  respuestas. `from_template_id` tiene cascada (si se borra la plantilla de
  origen, sus ramas desaparecen con ella); `to_template_id` **no** tiene
  cascada — borrar la plantilla de destino de una rama no debería arrastrar
  nada más, es una decisión de diseño explícita, no un descuido (afecta
  también a `tests/helpers/cleanup.js`, ver §5).
- `messages` gana `parent_message_id` y `branch_action_key`: para poder
  reconstruir después qué mensaje vino de qué rama, sobre qué mensaje
  original.
- `participant_campaign` gana `practice_username`/`practice_password`
  (texto plano deliberadamente: son credenciales de attrezzo generadas por
  el investigador, no un secreto de nadie que haga falta proteger con
  hashing).
- `deliveries` gana `credential_match_result boolean`: el único rastro que
  queda de un intento de credenciales de práctica.

## 3. Backend

### `lib/messageFactory.js` (nuevo, extraído de `routes/messages.js`)

Antes de este cambio, la lógica de "resolver los campos de un mensaje desde
una plantilla" y "crear un delivery + evento `entregado`" solo existía
inline dentro de `POST /messages/:id/send`. Los dos flujos nuevos de este
módulo —instanciar un guion de chat y seguir una rama del árbol de
respuestas— necesitaban exactamente lo mismo, una sola vez cada uno en vez
de en un envío masivo. En lugar de duplicarlo (y arriesgar que las dos
copias diverjan con el tiempo), se extrajo a un módulo compartido:
`rollJolting`, `resolveMessageFields`, `insertMessage`,
`createDeliveryForParticipant`. `routes/messages.js` se refactorizó para
usarlo; el comportamiento del envío masivo no cambió (verificado con la
batería completa de pruebas antes y después del refactor).

### `lib/boards.js` (nuevo)

CRUD del tablero real: `loadBoards` (con columnas y tareas anidadas,
incluyendo el nombre/color del responsable ya resuelto por `JOIN` contra
`fictitious_contacts`), `createBoard` (clona `board_templates.seed` si se
pasa `templateId`, o arranca con las 3 columnas estándar vacías),
`createTask`, `updateTask`, `deleteTask`, y los chequeos de pertenencia
(`assertBoardOwnership`, `assertColumnInBoard`, `taskBoardId`) que evitan
que un participante edite un tablero o mueva una tarea a una columna que no
es suya adivinando un id.

### `lib/chat.js` (nuevo)

`getOrCreateThread`: la primera vez que el participante abre el chat, se
crea su hilo y se "instancia" el guion más reciente de la campaña dentro de
una transacción (con `ON CONFLICT DO NOTHING` para no duplicar el guion si
dos pestañas piden el chat casi al mismo tiempo). Los pasos `scripted` se
copian tal cual; los pasos `attack` crean un `messages`/`deliveries` real
(mismo mecanismo que un correo) y se enlazan por `delivery_id`.
`appendReply` guarda la respuesta libre del participante — la única
excepción deliberada, y acotada, a "nunca guardar lo que el participante
escribió": es necesaria para que el chat tenga continuidad, y se juzgó de
sensibilidad baja (una conversación de trabajo, no una credencial).
`appendAttackToThread` inyecta en el hilo un ataque ya creado por otra vía
(la rama de respuestas).

### `routes/interaction.js` (nuevo, admin, `x-api-key`)

CRUD de `fictitious_contacts`, `board_templates`, `chat_script_templates` y
`message_branches`, más el endpoint de asignación de credenciales de
práctica (`POST /campaigns/:id/practice-credentials`). Se mantuvo separado
de `routes/tracking.js` a propósito: son dos superficies de autenticación
distintas (`x-api-key` del investigador vs. token de un solo uso del
participante) y mezclarlas habría sido fácil de hacer mal.

### `routes/tracking.js` (participante, solo token)

Rutas nuevas: `GET/POST /:token/boards*` y `/tasks*` (tableros y tareas del
propio participante, con los chequeos de pertenencia de `boards.js`);
`GET /:token/chat.json` y `POST /:token/chat/reply` (leer el hilo,
instanciándolo si hace falta, y responder libremente); y la pieza central
del árbol de respuestas, `POST /:token/d/:deliveryId/branch`: valida que el
mensaje sea un ataque con plantilla y que la acción elegida tenga una rama
definida, registra el evento `respuesta_participante` contra el delivery
original (con la acción elegida como `detail`), crea el siguiente
mensaje/delivery con `messageFactory`, y si el mensaje original llegó por
chat, lo agrega al mismo hilo (mismo remitente ficticio) en vez de mandarlo
a la bandeja de correo.

`checkCredentialMatch` compara en memoria lo enviado contra
`practice_username`/`practice_password` del participante y solo dejó su
resultado (booleano) en `deliveries.credential_match_result`; si el
participante no tiene credenciales de práctica asignadas, la columna queda
`NULL` (no se intenta comparar contra nada).

### `lib/decoy.js` (frontend del señuelo TaskFlow)

- "Mis tableros" reemplaza al tablero único: pestañas por tablero, botón
  "Nuevo tablero" (con selector opcional de plantilla), y en cada tarea un
  `<select>` de responsable poblado desde `fictitious_contacts` — nunca un
  campo de texto libre.
- Vista nueva "Chat de equipo": burbujas de conversación, los ataques se
  distinguen visualmente y enlazan a `/t/:token/d/:deliveryId`; el mensaje
  abierto ahí, si tiene ramas definidas, muestra botones de respuesta rápida
  que llaman a `POST .../branch`.
- Todo el estado que antes vivía en `localStorage` (`tfBoard()`) se
  reemplazó por llamadas reales al backend (`tfBoards()`, `tfChat()`,
  `tfApi()` como helper de `fetch`).

## 4. Por qué el sorteo de jolting de un ataque de chat está fijo en `TRUE`

`instantiateScript` no puede llamar a `createDeliveryForParticipant` (que
usa el pool general de conexiones) porque corre dentro de la transacción de
`getOrCreateThread` con un `client` dedicado — mezclar los dos rompería la
transacción. Como la probabilidad por defecto de las campañas ya es 1.0
desde la migración 006, fijarlo en `TRUE` reproduce exactamente ese
comportamiento por defecto. Si más adelante se necesita sortear jolting con
una probabilidad distinta de 1 también para ataques que llegan por chat, es
una mejora aparte, no un bloqueante de esta entrega.

## 5. Pruebas

`tests/integration/interaction.test.js` (nuevo, 6 casos, Postgres real, sin
mocks — misma convención que `tracking.test.js`):

1. CRUD de compañeros ficticios, incluyendo que borrar uno en uso por una
   tarea devuelve 409 en vez de romper la integridad referencial.
2. Plantillas de tablero: rechazo de un `seed` mal formado, y que crear un
   tablero desde una plantilla clona sus columnas/tareas con el responsable
   correcto (resuelto contra `fictitious_contacts`, no texto libre).
3. Ciclo de vida completo de tareas de un participante (crear tablero,
   agregar/editar/mover/borrar tarea) y aislamiento: un token ajeno no
   puede leer ni tocar los tableros de otro participante, y mover una tarea
   a una columna de otro tablero (propio o ajeno) se rechaza.
4. Chat: instanciación del guion (un paso `scripted` + un paso `attack`
   real, verificando que el ataque generó su `messages`/`deliveries`/evento
   `entregado` de verdad), que recargar el chat no duplica el guion,
   respuesta libre del participante, y que seguir una rama sobre un ataque
   de chat agrega el siguiente mensaje al mismo hilo.
5. Rama de respuestas sobre un ataque de **correo**: el siguiente mensaje
   aparece como delivery nuevo en la bandeja, no se crea ningún hilo de
   chat.
6. Credenciales de práctica: coincide/no coincide se refleja correctamente
   en `credential_match_result`, un participante sin credenciales asignadas
   deja la columna en `NULL`, y — la aserción de seguridad — ni el texto de
   la contraseña de práctica correcta ni el de un intento fallido aparecen
   en ninguna fila de `events` ni `chat_messages` después de la prueba.

Se aprovechó para corregir por adelantado `tests/helpers/cleanup.js`: como
`message_branches.to_template_id` no tiene cascada (a propósito, ver §2),
el `DELETE FROM templates` de limpieza habría fallado por violación de
llave foránea en cuanto existiera una prueba con ramas. Se agregó un
`DELETE FROM message_branches` previo, filtrando por plantillas de origen o
de destino que coincidan con el patrón de nombre de prueba.

Resultado: **112/112 pruebas pasan** (106 preexistentes + 6 nuevas), sin
modificar ninguna prueba existente más allá del refactor interno de
`messages.js` (que se verificó explícitamente que no cambia su
comportamiento).

## 6. Qué falta (no bloqueante para esta entrega, pero conviene saberlo)

- El panel admin (`admin.html`/`admin.js`) todavía no tiene una pantalla
  para crear compañeros ficticios, plantillas de tablero, guiones de chat o
  ramas de respuesta: hoy solo se pueden crear con `curl`/Postman contra
  `routes/interaction.js`. Es el siguiente paso natural para que el
  investigador arme escenarios sin tocar la API a mano.
- El sorteo de jolting para ataques de chat está fijo en `TRUE` (§4); si se
  quiere variar la probabilidad también ahí, hace falta que
  `instantiateScript` reciba y reutilice la conexión de transacción de otra
  forma (o se calcule el sorteo antes de abrir la transacción).
- Migración 010 se aplicó y verificó contra la base de pruebas local; sigue
  pendiente aplicarla en Supabase de producción con `psql`, igual que las
  migraciones anteriores (no se aplica sola al hacer `git push`/deploy en
  Render).
