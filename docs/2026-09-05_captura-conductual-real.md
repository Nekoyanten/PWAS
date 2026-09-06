# Captura conductual real (Tabla 1 §8.2.1, fila 1)

Fecha: 2026-09-05. Este documento explica, para alguien que nunca ha visto
este repositorio, qué se construyó, por qué se construyó así, y cómo se
verificó. Si ya conoces el proyecto puedes saltar a la sección 3.

## 1. Qué problema resuelve esto

El trabajo de grado (Tabla 1, §8.2.1) describe un pipeline de 7 módulos: (1)
captura conductual cruda, (2) preprocesamiento, (3) representación/features,
(4) inferencia con ML, (5) motor de decisión, (6) intervención, (7)
almacenamiento. Antes de esta sesión, el módulo 1 — la captura — **no
existía**. El repositorio registraba eventos de negocio gruesos (un
participante abrió un mensaje, hizo clic, envió un formulario) pero nunca
capturó la señal fina de comportamiento — cómo se mueve el mouse, cómo se
teclea — que la sección 8.2.3 necesita para calcular features (AUC, error
estándar, distancia media de la trayectoria del mouse; latencias entre
teclas) y entrenar cualquier modelo. Sin el módulo 1, los módulos 2-4 no
tienen con qué trabajar: eran, literalmente, el bloqueante principal del
proyecto (así estaba marcado en el estado del repositorio en Notion).

Esta sesión implementa el módulo 1 completo: captura en el navegador del
participante, transporte hasta el servidor, almacenamiento, y un endpoint
de exportación pensado para el pipeline de Python que vendrá después (ese
pipeline — preprocesamiento + ML — es un workstream aparte, fuera de este
repo Node/Express; aquí solo se entrega la materia prima que necesita).

## 2. Qué NO hace (invariante de privacidad del proyecto)

Este proyecto tiene, desde su diseño original, una regla explícita en la
cabecera de `db/schema.sql` y de `apps/api/src/lib/decoy.js`: **ninguna
pantalla captura contenido escrito por el participante**. La captura
conductual respeta esta regla por diseño, no por cuidado adicional:

- Nunca lee ni envía el valor de ningún campo de formulario.
- Nunca envía `event.key` (el carácter tecleado) — solo `event.code` (la
  tecla FÍSICA: `"KeyA"`, `"Backspace"`, `"Enter"`...). Con `event.code` se
  puede medir *ritmo* de tecleo (cuánto tarda entre teclas, qué tan rápido
  suelta una tecla) sin saber jamás *qué* escribió la persona.
- No hay una sola columna en el esquema donde un texto libre pudiera
  terminar guardado — ni siquiera por accidente.
- Un token de participante vencido o inválido responde `204` en silencio
  (nunca rompe la página ni expone un error al participante).

## 3. Cómo funciona, de punta a punta

```
Navegador del participante                    Servidor (Express)              Postgres
───────────────────────────                    ──────────────────              ────────
behavior-capture.js                            POST /t/:token/behavior
  escucha mousemove/mousedown/                   1. valida token (loadPC)
  mouseup/click/keydown/keyup/                   2. valida forma del lote
  visibilitychange                               3. sanea cada muestra          behavior_sessions
  → junta muestras en memoria                    4. INSERT sesión (upsert)  →   behavior_events
  → cada ~2.5s o 120 muestras,                   5. INSERT muestras (1 sola
    hace flush() por fetch()                        ida a la base, multi-fila)
  → si la pestaña se oculta antes
    del próximo flush, fetchLater()
    (o su polyfill) manda lo que
    quedó pendiente
```

### 3.1. Cliente: `apps/api/public/js/behavior-capture.js`

Es un script plano (sin dependencias, sin framework) que se activa así:

```html
<script src="/js/behavior-capture.js" data-token="..." data-phase="app"></script>
```

- `data-token` (obligatorio): el `access_token` del participante — el mismo
  que ya usa toda la URL `/t/:token/...`.
- `data-phase` (obligatorio): en qué pantalla está — `app` (el tablero de
  TaskFlow), `message` (mensaje abierto), `landing` (aterrizaje de un
  ataque) o `survey` (encuesta post-sesión). Sirve para poder analizar por
  separado, por ejemplo, "la dinámica de mouse justo al abrir un mensaje de
  ataque" vs. "en el tablero normal".
- `data-delivery-id` (opcional): a qué mensaje/ataque concreto pertenece
  esta pantalla, cuando aplica. Permite, más adelante, aislar la señal
  conductual de un ataque específico.

Si falta `data-token` o `data-phase`, o el navegador es demasiado viejo para
`crypto.randomUUID()`, el script simplemente no hace nada — nunca debe
romper la experiencia del participante ni el piloto.

**Dónde está incluido**: en las 4 pantallas donde el participante interactúa
activamente — `renderApp` (tablero), `renderMessage` (mensaje), las dos
variantes de `renderStimulusLanding` (aterrizaje de ataque) y `renderSurvey`
(encuesta) — todas en `apps/api/src/lib/decoy.js`, a través de un único
helper (`behaviorCaptureTag()`) para no repetir la misma etiqueta 4 veces.

**Muestreo**: `mousemove` se limita a ~25 Hz (una muestra cada 40 ms como
mínimo), porque el navegador dispara 100+ eventos por segundo y no aportan
señal extra para dinámica de mouse — solo saturarían la red y la base de
datos. `mousedown`/`mouseup`/`click`/`keydown`/`keyup` no se limitan: son
mucho menos frecuentes.

**Entrega confiable al cerrar la pestaña**: además del flush periódico
(cada 2.5 s), después de cada flush se arma una entrega de respaldo con la
API experimental `fetchLater()` para lo que se acumule después. Si el
participante cierra la pestaña o navega a otra página antes del siguiente
flush, esa entrega se dispara automáticamente al ocultarse la página, en vez
de perder las últimas muestras. Como `fetchLater()` todavía no tiene soporte
universal en navegadores (ver `modern-web-guidance`), el script incluye un
polyfill mínimo (`fetch` con `keepalive: true`, o `navigator.sendBeacon()`
como último recurso) para los navegadores sin soporte nativo.

### 3.2. Servidor: `POST /t/:token/behavior` (en `apps/api/src/routes/tracking.js`)

Recibe un lote de hasta 300 muestras por request (el mismo número que usa el
cliente como techo por flush, para que nunca se rechace un lote legítimo) y:

1. Valida el token igual que cualquier otra ruta de `/t/:token/...`
   (`loadPC`) — token inválido/vencido → `204` silencioso, no `404`.
2. Valida la forma del payload (`session_id` UUID, `phase` no vacío,
   `samples` un arreglo no vacío) → `400` si falta algo básico.
3. Sanea cada muestra individualmente: descarta las que tengan un tipo de
   evento no reconocido o un timestamp inválido, y recorta (`clamp`) las
   coordenadas x/y al rango de un `SMALLINT` de Postgres en vez de dejar que
   un valor fuera de rango tumbe el `INSERT` completo. Una muestra rara no
   debe perder el resto del lote.
4. Si después de sanear no queda ninguna muestra válida, `400`.
5. Guarda: un `UPSERT` en `behavior_sessions` (la primera vez que ve un
   `session_id` lo crea; las siguientes veces solo actualiza el contador y
   la marca de tiempo del último flush) y un `INSERT` multi-fila en
   `behavior_events` — una sola ida a la base para todo el lote, no una
   consulta por muestra.

**Deliberadamente NO usa el patrón `recordOnce`** que sí usa el resto de
este archivo para eventos de negocio (abierto/clic/etc., donde solo importa
que un evento haya pasado, no cuántas veces). Acá cada muestra individual
importa — es la señal en sí misma — así que se guardan todas.

### 3.3. Esquema: `db/migrations/004_behavior_capture.sql`

Dos tablas nuevas:

- **`behavior_sessions`**: una fila por "página con captura activa" (una
  carga del tablero, un mensaje abierto, un aterrizaje, la encuesta). Guarda
  `phase`, a qué `delivery_id` pertenece (si aplica), el tamaño de ventana
  del navegador, y cuántas muestras acumuló.
- **`behavior_events`**: una fila por muestra cruda — `t_ms` (milisegundos
  relativos al inicio de la sesión, no un timestamp absoluto), el tipo de
  evento, `x`/`y` cuando aplica, y `key_code` cuando aplica.

Decisiones de diseño explicadas en los comentarios del propio archivo SQL
(vale la pena leerlos si vas a tocar este esquema):

- **Dos tablas, no una**: evita repetir `phase`/`viewport`/participante en
  cada una de las miles de muestras por sesión.
- **El `id` de la sesión lo genera el navegador** (`crypto.randomUUID()`),
  no el servidor: así el cliente no necesita una ida y vuelta previa para
  pedir un id antes de poder capturar nada, y puede reintentar un lote sin
  duplicar la sesión.
- **`t_ms` es un entero relativo**, no un `TIMESTAMPTZ` por muestra: ocupa
  menos espacio, no depende de que el reloj del navegador del participante
  esté bien puesto, y es el formato que ya usa la literatura de dinámica de
  mouse/tecleo para calcular velocidad, aceleración y latencias.

### 3.4. Exportación: `GET /api/export/behavior-events.:format`

Endpoint de solo lectura, protegido por `x-api-key` (`requireAdmin`, igual
que el resto de `/api/export`), que entrega **la materia prima cruda, sin
calcular ninguna feature** — una fila por muestra, en el orden en que
ocurrió. El pipeline de preprocesamiento/ML (Python, fuera de este repo) la
lee con pandas/numpy y arranca desde ahí; este endpoint no intenta adivinar
qué necesitará ese pipeline más allá de entregarle todo el contexto para
poder estratificar sin tener que volver a consultar la base:

| columna | de dónde sale | para qué sirve |
|---|---|---|
| `session_id` | `behavior_sessions.id` | agrupar muestras de una misma sesión |
| `participant_campaign_id` | `participant_campaign.id` | agrupar sesiones de un mismo participante, **sin exponer `external_hash`** (ver más abajo) |
| `phase`, `viewport_w`, `viewport_h` | `behavior_sessions` | contexto de la sesión |
| `role`, `group_assignment`, `team_label` | `participants` | estratificar sin otro JOIN |
| `attack_vector`, `is_attack` | `messages` (si la muestra pertenece a un delivery) | aislar "durante exposición a un ataque de vector X" |
| `t_ms`, `event_type`, `x`, `y`, `key_code` | `behavior_events` | la muestra en sí |

Admite `?campaign_id=<uuid>` para acotar a una sola campaña, y devuelve
JSON o CSV según el sufijo de la URL (`.json` / `.csv`), igual que los
demás exports de este proyecto.

**Nota importante descubierta durante la revisión de este trabajo**: la
primera versión de este endpoint incluía `p.external_hash` en el `SELECT`.
Los tests existentes del proyecto (`tests/integration/admin.test.js`) ya
establecen, para `/coverage` y `/overview`, que ningún endpoint debe
exponer `external_hash` — es el hash del identificador real de la persona,
calculado fuera de este sistema (ver cabecera de `db/schema.sql`). Se
corrigió antes de entregar este trabajo: ahora se usa
`participant_campaign_id` (un UUID que genera este mismo sistema) para
poder agrupar sesiones de un mismo participante sin ese riesgo. El test
nuevo `tests/integration/behavior-capture.test.js` verifica explícitamente
que `external_hash` nunca aparece en este export, para que una futura
regresión no vuelva a introducir el mismo problema sin que un test lo note.

## 4. Cómo se verificó (no solo lectura de código)

Este sandbox tiene PostgreSQL 16 disponible localmente, así que se pudo
probar contra una base real en vez de solo revisar sintaxis:

1. Se creó una base `pwas_test` local y se le aplicó `db/schema.sql` + las
   4 migraciones (`001` a `004`) en orden.
2. Se corrió la suite completa existente (`npm test`, 16 tests) contra esa
   base **antes** de escribir ningún test nuevo, para tener una línea base
   limpia.
   - Al hacerlo apareció un hallazgo real, no relacionado con este cambio:
     el test `tests/integration/intervention.test.js` se colgaba
     indefinidamente contra una base a la que solo se le había aplicado
     `db/schema.sql` + la migración `004` (saltándose `001`-`003`). La
     causa: `db/schema.sql` no incluye los valores de enum
     `intervencion_mostrada` / `intervencion_cancelada` que agrega la
     migración `003`, y Express 4 no reporta un error cuando una promesa
     rechazada escapa de un handler async — la petición simplemente nunca
     responde. Esto no es un bug de esta sesión ni de la captura
     conductual: es que `db/schema.sql`, para una base nueva, necesita
     aplicarse **junto con** la migración `003` (no basta con `schema.sql`
     solo, aunque el comentario de cabecera de `001` y `002` sugiere que sí
     basta). Se resolvió aplicando las migraciones en orden completo; queda
     anotado aquí por si alguien más tropieza con lo mismo, y sería sano
     que una futura sesión regenere `db/schema.sql` para que incluya ya los
     valores de enum de `003` y evite esta trampa.
3. Se escribió `tests/integration/behavior-capture.test.js` (8 casos:
   lote válido, acumulación en la misma sesión, token inválido, muestras
   inválidas descartadas sin tumbar el lote, límites de tamaño de lote,
   clamping de coordenadas fuera de rango, contenido del export, y que el
   export exige `x-api-key`) y se corrió contra la misma base.
4. Se corrió la suite completa una vez más (24 tests: 16 preexistentes + 8
   nuevos) para confirmar que nada se rompió.
5. Se verificó manualmente, con scripts puntuales fuera de la suite de
   tests, que: el archivo estático `/js/behavior-capture.js` se sirve
   correctamente, y que las 4 pantallas (`app`, `message`, `landing`,
   `survey`) efectivamente incluyen la etiqueta `<script>` con los atributos
   `data-*` correctos (incluido `data-delivery-id` cuando corresponde).

Resultado final: **24/24 tests pasan** contra Postgres real.

## 5. Qué falta (para que quede explícito el límite de este trabajo)

Este trabajo entrega el módulo 1 (captura) completo y probado. **No**
incluye:

- Módulo 2 (preprocesamiento: resampleo, suavizado, z-score) ni módulo 3
  (representación: features AUC/SE/MD, latencias de tecleo) — son
  workstreams de Python, fuera de este repo, que ahora sí tienen datos
  reales con qué trabajar gracias a este endpoint de exportación.
- Módulo 4 (inferencia ML) y módulo 5 (motor de decisión con umbral de
  riesgo real) — dependen de 2 y 3.
- Ningún cambio al dashboard de administración: los datos crudos existen en
  la base y son exportables, pero no hay todavía una vista agregada de
  "cuántas muestras/sesiones de captura hay por campaña" en el panel admin.
  Es una extensión natural, no incluida en este trabajo.

## 6. Aplicar esto

El código vive en un parche (`git diff` desde `origin/main`, sin push
porque esta sesión no tiene permiso de escritura sobre el repositorio de
GitHub). Para aplicarlo:

```bash
git apply captura-conductual-real.patch
psql "$DATABASE_URL" -f db/migrations/004_behavior_capture.sql   # ya aplicada en Supabase producción, ver Notion
cd apps/api && npm test                                          # 24/24 deben pasar
```

La migración `004` ya está aplicada en la base de datos de producción
(Supabase, proyecto `PWAS`) — el `psql` de arriba es solo para replicarla en
un entorno local o de pruebas.
