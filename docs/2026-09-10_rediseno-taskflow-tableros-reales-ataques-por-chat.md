# 2026-09-10 — Rediseño "Modernist" de TaskFlow, prioridad/checklist reales en el tablero, y plantillas de ataque por chat directo con conteo por canal

## 1. Contexto

El usuario adjuntó un prototipo visual (`Arquitectura TaskFlow colaborativa.zip`, un export tipo
"Bundled Page" de un canvas de diseño) y pidió tres cosas en un solo mensaje:

1. Integrar el **diseño y la estructura** de ese prototipo a la aplicación real ("escoge la versión
   nueva en diseño y estructura"), pero sin perder nada de lo ya construido ("no quiero que dañes
   más cosas").
2. Que lo nuevo **funcione de verdad**, no solo de adorno visual ("necesito que funcione realmente
   bien").
3. Terminar la administración pendiente del panel admin: ampliar los mensajes de ataque y crear
   "ataques por chat" como categoría propia, con una función en el panel admin para
   **administrarlos** y para **contarlos**.

Dado el tamaño y la ambigüedad real de los puntos 1 y 3 (un prototipo de diseño no es código
ejecutable, y "ataques por chat" podía interpretarse de formas muy distintas en alcance), se
confirmaron dos decisiones con el usuario antes de escribir código:

- **Alcance del rediseño**: adoptar la paleta/tipografía del prototipo en toda la app, fusionar
  Bandeja + Chat en un solo panel lateral con pestañas (como en el prototipo), y hacer que
  prioridad y checklist de cada tarjeta se guarden de verdad en la base de datos (no solo en el
  DOM).
- **Ataques por chat**: agregar "Chat directo" como un tercer formato de plantilla (junto a
  Correo/Tarea) en la biblioteca del paso 3, y un contador agregado por canal (expuestos / abiertos
  / cayeron / reportados) en el paso 6 · Interacción — no una tabla nueva fila por fila.

Este documento cubre ambas entregas.

## 2. El prototipo era una referencia de diseño, no código a copiar

El zip contenía `taskflow-preview.html`, un "Bundled Page": no es HTML plano, sino un
`<script type="__bundler/manifest">` + `<script type="__bundler/template">` con el marcado
codificado como JSON, pensado para un runtime de canvas propio (atributos `sc-camel-*`,
interpolación `{{ }}`, `<sc-for>`/`<sc-if>`). Se decodificó con Python (`json.loads` sobre el JSON
del template) para poder leer el diseño real: paleta, tipografía, estructura de columnas/tarjetas,
panel lateral con pestañas.

Ese HTML decodificado se usó **solo como referencia visual y estructural** — no es Alpine.js ni
Express, y su chat es "comentarios por tarjeta" (una conversación distinta por cada tarjeta del
tablero), mientras que el chat real de esta app es "Chat de equipo": un único hilo guiado por
guion con inyección de ataques y árbol de respuestas (migración 010), que es instrumentación de
investigación real y no se podía reemplazar sin perder eso. La decisión fue: adoptar el diseño y la
idea de "panel lateral con pestañas", pero mantener el Chat de equipo real dentro de una de esas
pestañas, en vez de sustituirlo por comentarios por tarjeta.

## 3. Migración 013 — prioridad y checklist reales en `board_tasks`

Antes, prioridad y checklist de una tarjeta solo existían si se agregaban a mano en el DOM: no había
columnas para ellas en `board_tasks`, así que cualquier cambio se perdía al recargar. Se agregó:

```sql
ALTER TABLE board_tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'media'
  CHECK (priority IN ('alta', 'media', 'baja'));
ALTER TABLE board_tasks ADD COLUMN checklist JSONB NOT NULL DEFAULT '[]'::jsonb;
```

- **`priority` como `CHECK` y no un `ENUM` nuevo** (a diferencia de `landing_kind`/`message_kind`):
  son 3 valores fijos de uso exclusivo de esta tabla, y un `CHECK` se puede reemplazar con un
  `ALTER TABLE` simple si algún día cambia; un `ENUM` de Postgres no se achica ni renombra fácil.
- **`checklist` como JSONB**, igual que `landing_config`, `board_templates.seed` y
  `chat_script_templates.script`: un arreglo `[{"title": "...", "done": bool}, ...]` que se
  reemplaza entero en cada guardado, sin tabla ni RLS aparte (hereda el RLS de `board_tasks`).

Aplicada a la base de prueba local **y a producción (Supabase, proyecto `ihemxqzuolhmkwikhnlg`)**,
verificada por esquema en ambas.

## 4. Backend: `priority`/`checklist` de verdad en el ciclo de vida de una tarea

`apps/api/src/lib/boards.js`: `createBoard` (clonado de plantilla), `createTask` y `updateTask`
ahora leen/escriben estas dos columnas, con saneamiento explícito (`VALID_PRIORITIES`,
`sanitizeChecklist`) para que un valor raro nunca llegue a depender de un `CHECK` de Postgres para
rechazarse.

El punto delicado fue `updateTask`: el resto de sus campos usan `COALESCE($n, columna)` (si no
mandaste el campo, no se toca). Eso **no sirve** para `priority`/`checklist`, porque `"media"` y
`"[]"` son valores válidos con intención propia, no un "no lo toques" — con `COALESCE` normal,
cualquier edición de tarea que no mencionara prioridad la habría reseteado a `"media"` sin que nadie
lo pidiera. Se resolvió con un booleano explícito de "¿vino este campo?" (`fields.priority !==
undefined`) que viaja hasta un `CASE WHEN` en SQL, documentado inline como una divergencia
deliberada del patrón `COALESCE` de las líneas de al lado.

`apps/api/src/routes/tracking.js` (crear/editar tarea del participante) y
`apps/api/src/routes/interaction.js` (`validateBoardSeed`, para que una plantilla de tablero con
prioridad/checklist en su semilla se valide al guardarla, no al fallar en silencio al instanciarse)
se actualizaron para pasar estos campos con la misma distinción "no vino" vs. "vino con este valor".

## 5. Rediseño visual "Modernist" — retinte de variables, no reescritura de selectores

Todo el CSS de `apps/api/src/lib/decoy.js` ya fluye a través de un único bloque de variables
(`--bg`, `--panel`, `--ink`, `--brand`, `--radius`, `--shadow*`, …) que cada clase referencia con
`var(--x)`. Eso permitió adoptar la paleta del prototipo ("Modernist": fondo neutro cálido
`#f3f2f2`, acento naranja-rojo `#ec3013`, tipografía Archivo, esquinas a 0px, bordes de 2px) con un
solo bloque `:root{...}` reemplazado — sin tocar el marcado ni los bindings de Alpine de cada
componente, lo que redujo mucho el riesgo de romper algo al hacerlo.

## 6. Estructura: Bandeja + Chat fusionados en un panel lateral con pestañas

Siguiendo el patrón del prototipo (panel lateral con pestañas "Bandeja"/"Detalle"), se fusionaron
las vistas separadas "Bandeja" y "Chat" dentro del panel lateral del Tablero, ahora con dos
pestañas ("Bandeja" / "Chat") en vez de ser tres ítems de navegación distintos. El Chat de equipo
real (guion + inyección de ataques + árbol de respuestas) se conservó tal cual, solo relocalizado y
restilizado.

Esto fue de bajo riesgo por dos razones ya existentes en el código, verificadas antes de tocar
nada:

- La función `show(v)` del lado del cliente ya caía a la vista por defecto si `v` no es una clave
  válida (`if(!TITLES[v]) v=DEFAULT_VIEW`) — así que quitar `"bandeja"`/`"chat"` de `VIEWS` no
  rompe ningún enlace o botón viejo que apuntara a ellas: caen automáticamente a "Tablero", que es
  exactamente donde quedó su contenido.
- La captura conductual (`behavior-capture.js`) ya marca `data-phase="app"` para toda la SPA sin
  importar la sub-vista activa — fusionar sub-vistas no afecta esa instrumentación.

Se agregó un puente mínimo de eventos (`window.dispatchEvent(new CustomEvent('tf-panel', ...))`)
para que los dos botones de acceso rápido de la pantalla de inicio ("Ver la bandeja" / "Chat de
equipo") sigan abriendo la pestaña correcta dentro del panel fusionado.

## 7. Tarjetas del tablero: prioridad y checklist visibles y editables

Cada tarjeta ahora muestra una insignia de prioridad (alta/media/baja) y, si tiene ítems, una barra
de progreso del checklist (`X/Y`). El formulario de edición de una tarjeta (doble clic) agregó un
selector de prioridad de 3 botones y un editor de checklist (marcar/desmarcar, quitar, agregar
ítem nuevo) que guarda contra el `PATCH` de tarea ya existente, ahora extendido para aceptar estos
dos campos.

## 8. Verificación del rediseño

- Suite completa: sin regresiones.
- Smoke test manual contra la base de prueba: crear tablero → columna → tarea con prioridad y
  checklist → `PATCH` cambiando solo el título (confirma que prioridad/checklist NO se resetean) →
  `PATCH` cambiando solo prioridad (confirma que el checklist no se toca) y viceversa.
- Capturas de pantalla (Playwright, Chromium) de: el tablero completo con la paleta nueva y las
  insignias de prioridad; el formulario de edición con el selector de prioridad y el checklist
  abiertos; la pestaña "Chat" activa dentro del panel fusionado. Las tres confirman el resultado
  visual esperado y que el mecanismo de pestañas funciona.

## 9. Plantillas "Chat directo" — administrar ataques por chat como su propia categoría

### Diagnóstico

El motor de chat (`lib/chat.js`) ya podía insertar **cualquier** plantilla de ataque (correo o
tarea) dentro de un guion de chat desde la migración 010 — al instanciarse, siempre fuerza
`messages.kind = 'chat'` en el mensaje resultante, sin importar el `kind` de la plantilla de
origen. El ENUM `message_kind` de la base ya soportaba el valor `'chat'` desde esa misma migración.
Lo que faltaba, documentado explícitamente como pendiente en un comentario del propio test de
integración (`interaction.test.js`), era que **el admin pudiera guardar una plantilla marcada como
"de chat"**: el validador de `POST /api/templates` (`routes/templates.js`) solo aceptaba
`kind: "email" | "task"`, y el formulario de plantillas (paso 3) ni siquiera ofrecía la opción.

### Fix

- `routes/templates.js`: `KINDS` ahora incluye `"chat"`.
- `admin.html` (paso 3, formulario de plantilla): tercera opción "Chat directo" en el selector de
  Formato, con una nota aclarando que es solo para insertarse en un guion de chat (paso 6), no para
  enviarse por bandeja.
- `admin.js`:
  - `loadTemplates()` ahora rotula el formato con un mapa de 3 vías (`correo` / `tarea` / `chat
    directo`) en vez del ternario binario anterior, tanto en la tabla de ataques como en la de
    relleno.
  - `fillMsgTemplateSelect()` (paso 4, "Enviar mensajes") **excluye** las plantillas de kind
    `"chat"` de "Partir de una plantilla": ese formulario envía a la bandeja/tareas del
    participante, un formato que ese `<select>` de "Formato" ni siquiera ofrece — mostrarlas ahí
    llevaría a un mensaje inconsistente.
  - El desplegable de plantilla dentro de un paso "Insertar ataque" (guiones de chat, paso 6) ahora
    rotula cada opción con su formato (`[correo] …`, `[chat directo] …`) para que el admin distinga
    de un vistazo cuáles fueron pensadas para chat — pero **sigue mostrando cualquier plantilla de
    ataque**, igual que antes: restringirlo solo a `kind: "chat"` habría roto guiones ya armados con
    plantillas de correo/tarea, que siguen siendo un uso válido y ya probado del sistema.

## 10. Conteo agregado de ataques por canal

### Fix

`routes/dashboard.js` ya tenía una función compartida, `attackMetricsSQL(groupCol)`, usada para
desglosar métricas de ataque por técnica (`m.vector`) y por rol (`p.role`) dentro de
`GET /api/dashboard/overview`. Se reusó la misma función con `groupCol = "m.kind"` para agregar un
tercer desglose, `por_canal`, sin escribir SQL nuevo: expuestos, abrieron, hicieron clic, cayeron,
reportaron y `%` de caída, agrupados por `email` / `task` / `chat`.

En `admin.html` se agregó un panel nuevo, "Ataques por canal", en el paso 6 · Interacción (debajo
de "Guiones de chat", que es donde se administran los ataques de chat) con una tabla de 3 filas.
`admin.js` agrega `loadChannelCounts()`, llamada cada vez que se entra al paso 6, que consume
`por_canal` de `/api/dashboard/overview` y lo pinta con las mismas etiquetas de formato que el
resto del panel.

Nota de diseño: igual que `por_tecnica`/`por_rol` (que ya existían en ese mismo endpoint sin
filtrarse por campaña), este conteo es **global** — de todas las campañas, no solo la activa. Se
dejó así deliberadamente para no cambiar el comportamiento ya establecido de ese endpoint (que
comparte la misma consulta) ni introducir un filtro nuevo por campaña que las otras dos
dimensiones no tienen; el panel lo aclara con un texto de ayuda visible.

### Verificación

Prueba de integración nueva (`interaction.test.js`): crea una plantilla con `kind: "chat"`,
confirma que un `kind` inválido (`"sms"`) sigue rechazándose con 400, arma un guion de chat que la
usa, entrega el ataque a un participante real, y verifica tanto que el `messages.kind` resultante
es `'chat'` en la base como que `GET /api/dashboard/overview` devuelve una fila `por_canal` con
`clave: "chat"` y al menos un expuesto. Suite completa: **114/114** (113 previas + esta).

Smoke manual adicional contra un servidor real: crear plantilla `kind: "chat"` (201), crear
plantilla con `kind` inválido (400 con el mensaje de error correcto), y confirmar la forma de
`GET /api/dashboard/overview` (incluye `por_canal`). Capturas de pantalla del panel admin
confirmando: la nueva opción "Chat directo" en la tabla de plantillas (columna "Formato"), y el
panel "Ataques por canal" renderizado en el paso 6.

## 11. Archivos modificados

- `db/migrations/013_prioridad_checklist_tareas.sql` — nueva, aplicada a local y producción.
- `apps/api/src/lib/boards.js` — prioridad/checklist en `createBoard`/`createTask`/`updateTask`.
- `apps/api/src/routes/tracking.js` — pasa `priority`/`checklist` respetando "no vino" vs. "vino".
- `apps/api/src/routes/interaction.js` — valida `priority`/`checklist` en la semilla de una
  plantilla de tablero.
- `apps/api/src/lib/decoy.js` — retinte de variables CSS (paleta/tipografía "Modernist"), fusión de
  Bandeja+Chat en el panel lateral con pestañas, insignia de prioridad y barra de checklist en la
  tarjeta, editor de prioridad/checklist en el formulario de edición.
- `apps/api/src/routes/templates.js` — `KINDS` acepta `"chat"`.
- `apps/api/src/routes/dashboard.js` — `por_canal` en `GET /api/dashboard/overview`.
- `apps/api/public/admin.html` — opción "Chat directo" en el formulario de plantillas; panel nuevo
  "Ataques por canal" en el paso 6.
- `apps/api/public/admin.js` — rótulos de formato de 3 vías, exclusión de plantillas de chat del
  envío por bandeja, etiquetado de formato en el selector de "insertar ataque", `loadChannelCounts()`.
- `apps/api/tests/integration/interaction.test.js` — prueba nueva de plantillas de chat directo +
  conteo por canal; comentario desactualizado corregido.

## 12. Qué queda pendiente

- El conteo por canal (y `por_tecnica`/`por_rol`, que ya existían) es global, no por campaña. Si se
  necesita filtrarlo por campaña más adelante, hay que decidir si conviene cambiar las tres
  dimensiones a la vez (para no dejarlas inconsistentes entre sí) — no se hizo en esta entrega para
  no tocar comportamiento ya establecido sin que se pida explícitamente.
- El desplegable de "insertar ataque" en un guion de chat sigue aceptando cualquier plantilla de
  ataque (correo/tarea/chat), no solo las marcadas como `"chat"` — es una decisión deliberada (ver
  sección 9), pero si en algún momento se quiere *forzar* que un guion de chat solo use plantillas
  de chat directo, es un cambio de una línea (`.filter((t) => t.is_attack && t.kind === "chat")`)
  que no se aplicó para no romper guiones ya guardados con plantillas de otro formato.
- Los otros vectores de ataque descritos en
  `docs/2026-09-09_diversificacion-vectores-ataque.md` (SMS, adjuntos simulados, SSO ficticio)
  siguen sin construirse — sigue siendo una decisión de alcance aparte, no tocada en esta entrega.
