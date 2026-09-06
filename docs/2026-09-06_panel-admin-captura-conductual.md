# Panel admin: resumen y descarga de la captura conductual

Fecha: 2026-09-06. Este documento explica, para alguien que nunca ha visto
este repositorio, qué se construyó, por qué se construyó así, y cómo se
verificó. Es un complemento pequeño a
`docs/2026-09-05_captura-conductual-real.md` (captura conductual real): ese
trabajo guardaba los datos, pero para verlos había que llamar al endpoint de
exportación a mano con Postman/Insomnia. Aquí se agrega la manera de verlos
y descargarlos directamente desde el panel admin, sin herramientas externas.

## 1. Qué problema resuelve esto

El usuario pidió específicamente: "agregues el botón de descargar la captura
conductual directo en el panel del admin". Antes de este cambio, la única
forma de obtener los datos crudos era `GET /api/export/behavior-events.csv`
con el header `x-api-key`, algo que solo se podía hacer con un cliente HTTP
aparte (Postman, curl). Esto agrega, dentro de la pestaña "5 · Resultados"
del panel admin (`admin.html`), justo debajo de las tarjetas resumen que ya
existían:

1. Una tabla con un resumen agregado por pantalla ("fase": Calibración,
   Página del ataque, Mensaje abierto, Tablero/TaskFlow, Encuesta): cuántas
   sesiones, cuántos participantes, duración promedio, y conteos de
   movimientos de mouse / clics / teclas.
2. Un botón "Descargar captura conductual (CSV)" que baja el mismo CSV
   crudo (una fila por muestra individual) que antes solo se podía pedir por
   Postman, ahora con un clic.

## 2. Qué NO hace (mismo invariante de privacidad del proyecto)

Esto es una capa de visualización sobre datos que ya existían — no cambia
qué se captura ni qué se guarda. Sigue valiendo todo lo ya documentado en
`2026-09-05_captura-conductual-real.md`: nunca se captura ni se muestra lo
que el participante escribió, solo la tecla física y su ritmo. La tabla
resumen tampoco expone ninguna fila por participante identificable — son
conteos y promedios por fase, igual que el resto de `dashboardRouter`.

## 3. Cómo funciona, de punta a punta

### 3.1. Backend: `GET /api/dashboard/behavior-summary` en `apps/api/src/routes/dashboard.js`

Nuevo endpoint, mismo patrón que sus vecinos (`/by-team`, `/fall-reasons`):
requiere `x-api-key` (`requireAdmin`), acepta `?campaign_id=` opcional, y
devuelve `{ por_fase: [...] }` con una fila por `phase`.

La consulta usa **dos CTEs separadas** (`sess_agg` para sesiones/duración,
`events_agg` para conteos de eventos) en vez de un solo `JOIN` seguido de
`GROUP BY`. Esto es deliberado: `behavior_sessions` es 1-a-muchos con
`behavior_events` (una sesión tiene muchas muestras), así que unir ambas
tablas *antes* de agregar duplicaría cada fila de sesión una vez por cada
muestra que tenga — inflando `sesiones`, `participantes` y
`duracion_prom_seg` (una sesión con 300 muestras contaría como 300
sesiones). Separar las dos agregaciones y unirlas por `phase` al final evita
ese bug de fan-out por completo. La prueba nueva (ver sección 4) construye
un escenario específico para esto: dos sesiones reales pero con distinto
número de muestras cada una (7 en total), y verifica que `sesiones` siga
dando 2, no 7.

`duracion_prom_seg` es el promedio de (última muestra − primera muestra) por
sesión de esa fase — un proxy razonable de "cuánto tiempo pasó ahí" para
fases de una sola pantalla (`landing`, `calibration`), pero en `app` abarca
toda la navegación entre mensajes, no una tarea puntual. Para "tiempo de
reacción a un ataque específico" ya existe una métrica más precisa,
`tiempo_reaccion_ms`, en el endpoint `/api/dashboard/overview` que ya
existía antes de este cambio.

### 3.2. Frontend: `apps/api/public/admin.html` + `admin.js`

- `admin.html`: un nuevo `<div class="panel">` dentro de la pestaña de
  Resultados, con la tabla (`#behTable`), el botón de descarga
  (`#downloadBehaviorBtn`, mismo estilo `btn-sm ghost` que ya usaba
  `#downloadLinksBtn` para los enlaces de participantes) y texto explicativo
  sobre qué sí/no se captura.
- `admin.js`: `loadResults()` ahora también llama a la nueva función
  `loadBehaviorSummary()`, que pide `/api/dashboard/behavior-summary` y
  pinta la tabla (con `PHASE_LABEL` traduciendo el nombre técnico de cada
  fase a una etiqueta legible). El botón de descarga sigue exactamente el
  mismo patrón que ya usaba `downloadLinksBtn`: un `fetch()` manual (no el
  helper `api()`, que solo entiende JSON) al endpoint CSV existente, con el
  `x-api-key` en el header, convertido a `Blob` y descargado con un `<a>`
  temporal.

No se tocó el endpoint de exportación CSV (`/api/export/behavior-events.csv`)
en sí — ya existía desde la implementación original de la captura
conductual; este trabajo solo lo conecta a un botón en la interfaz.

## 4. Cómo se verificó

1. Se cargó `db/schema.sql` + las 5 migraciones en una base de pruebas local
   de Postgres, y se corrió la suite completa existente como línea base:
   **32/32 tests pasan**, sin tocar nada todavía.
2. Se agregaron 2 pruebas nuevas a
   `tests/integration/behavior-capture.test.js`:
   - Una que crea 2 sesiones (2 participantes distintos) en la misma fase,
     con cantidades de muestras deliberadamente distintas entre sí (5 y 2,
     mezclando mousemove/click/keydown/keyup), y verifica que
     `behavior-summary` reporte `sesiones: 2`, `participantes: 2` y los
     conteos exactos de `mousemove`/`clics`/`teclas` — específicamente para
     probar que el fan-out descrito en 3.1 NO ocurre.
   - Una que confirma que el endpoint exige `x-api-key` (401 sin él), mismo
     criterio que el resto de `/api`.
   - Al escribir la primera prueba se encontró un bug real: `sesiones` y
     `participantes` venían del `COUNT(*)`/`COUNT(DISTINCT ...)` de Postgres
     sin castear a `::int` (a diferencia de los conteos de eventos, que sí
     lo hacían), así que el driver `pg` los devolvía como *strings* en el
     JSON (`"2"` en vez de `2`) en vez de números. Se corrigió agregando
     `::int` a esas dos columnas en la consulta.
3. Suite completa después del fix: **34/34 tests pasan** (32 preexistentes +
   2 nuevos).
4. Verificación de extremo a extremo con un navegador real (Chromium vía
   Playwright): se sembraron datos reales de captura conductual vía HTTP
   (igual que un participante real navegando), se abrió `admin.html`, se
   navegó a la pestaña Resultados, y se confirmó que la tabla muestra los
   conteos exactos esperados (1 sesión, 1 participante, 2 mousemove, 1 clic,
   2 teclas) y que el botón de descarga efectivamente dispara una descarga
   de un CSV con el `session_id` sembrado y sin ningún dato personal
   identificable. Este script de verificación fue una herramienta de
   comprobación, no forma parte del patch entregado.

## 5. Respuesta a las preguntas del usuario

Con este endpoint ya construido y verificado contra datos reales, las
respuestas concretas son:

- **"¿Podemos medir el log de todo lo que hace la persona, ejemplo que
  digita, cómo lo hace, y cuánto se demora en cada tarea?"** Sí, con un
  matiz importante: se mide el *ritmo* de tecleo (tiempo entre `keydown` y
  `keyup` de cada tecla física, vía `key_code`), nunca *qué* tecla en
  términos de carácter ni el contenido resultante — eso es una decisión de
  privacidad deliberada del proyecto, no una limitación técnica. El tiempo
  por tarea/pantalla ya se ve en la nueva columna "Duración prom." para
  pantallas de una sola tarea (Calibración, Página del ataque); para la
  pantalla del tablero (que agrupa varios mensajes) esa duración abarca toda
  la navegación, no un mensaje puntual — para "cuánto tardó en reaccionar a
  ESTE ataque específico" ya existe `tiempo_reaccion_ms` en el dashboard
  general (`/api/dashboard/overview`), que mide desde que se le muestra el
  mensaje de ataque hasta que hace clic en él.
- **"¿Vemos los clics que hacen por cada tarea y cómo se mueven por la
  página?"** Sí. La tabla nueva ya muestra el conteo de clics y de
  movimientos de mouse por pantalla, y el CSV descargable trae la
  trayectoria completa: cada movimiento de mouse individual con su posición
  (x, y) y marca de tiempo, fila por fila, para reconstruir el recorrido
  completo de un participante por la página si hace falta ese nivel de
  detalle (p.ej. para el pipeline de preprocesamiento/ML fuera de este
  repo).

## 6. Qué falta (límite explícito de este trabajo)

- La tabla resumen es agregada por fase, no muestra la trayectoria completa
  de mouse ni gráficas — para eso está el CSV descargable. Una
  visualización de la trayectoria (p.ej. un mapa de calor) sería un trabajo
  aparte, fuera del alcance de lo pedido aquí.
- No se agregó paginación ni filtro de fecha al CSV descargable: baja todos
  los eventos de la campaña seleccionada de una vez, igual que ya hacía el
  endpoint de exportación antes de este cambio.

## 7. Aplicar esto

```bash
git apply 0003-panel-admin-captura-conductual.patch
cd apps/api && npm test   # 34/34 deben pasar
```

No requiere ninguna migración nueva de base de datos — usa las tablas que
ya existían desde `004_behavior_capture.sql`.
