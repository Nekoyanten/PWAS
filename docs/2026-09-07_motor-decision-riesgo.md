# Motor de decisión con umbral de riesgo real, en modo sombra (TG §8.2.1 Tabla 1, módulo 5 · §8.2.5)

Fecha: 2026-09-07. Este documento cubre el módulo 5 de la tabla de estado
del repositorio ("Motor de decisión, umbral de riesgo"), que dependía de
que los módulos 2-4 (preprocesamiento, representación, inferencia/ONNX)
estuvieran listos — lo estaban desde
`docs/2026-09-06_pipeline-ml-offline.md` y
`docs/2026-09-07_preprocesamiento-conductual.md`.

## 1. Por qué hacía falta

El aviso "Espera un momento…" (jolting, `docs/2026-09-06_jolting-adaptativo.md`)
decide hoy si mostrarse con una regla deliberadamente simple: un sorteo
fijado al momento del envío (`deliveries.jolting_roll`), con probabilidad
configurable por campaña. Es una simplificación honesta de fase 1 — mide
si la gente cae en el engaño incluso con una advertencia parcial, pero no
es lo que describe la versión final de §8.2.5: un **puntaje de riesgo
calculado en tiempo real**, a partir de cómo se mueve y teclea la persona
en el momento del clic, comparado contra un umbral.

Ese puntaje ya se podía calcular — el modelo temporal (TCN+Transformer)
entrenado y exportado a ONNX en el ítem anterior recibe exactamente las
dos secuencias crudas (mouse y teclado) que ya se capturan en producción.
Lo que faltaba era conectar ese modelo a la ruta que sirve el clic real
(`GET /t/:token/d/:deliveryId/go`) y decidir, con criterio, si su salida
debía **gatear** algo todavía.

## 2. Dos decisiones de diseño, y por qué

**Dónde corre la inferencia: en el servidor (`onnxruntime-node`), no en el
navegador.** Dos razones concretas, no solo preferencia:

- Enviar el modelo (247 KB) y una librería de inferencia a la página
  señuelo es una pista objetiva de que esa página no es lo que aparenta —
  justo lo que el diseño del estudio necesita evitar.
- El puntaje se calcula sobre los mismos eventos de `behavior_events` que
  ya llegan al servidor vía `/t/:token/behavior`; no hace falta
  duplicarlos al cliente para poder inferir.

**Cómo se activa: en modo sombra, no como gate real.** El modelo se
entrenó con etiquetas 100% sintéticas (el piloto real, ya aprobado por el
comité de ética, todavía no ha producido datos de encuesta reales —
`docs/2026-09-06_pipeline-ml-offline.md` §4). Dejar que un puntaje
calculado sobre una etiqueta sintética decida si un participante real ve
o no el aviso sería usar un resultado de validación mecánica del pipeline
como si fuera una medición científica. Así que esta entrega:

- Calcula y guarda el puntaje de riesgo, y lo que la decisión *habría
  sido* contra el umbral de la campaña, en **cada** clic sobre un mensaje
  de ataque — para poder analizarlo después.
- **No cambia en nada** la ruta de decisión real. `joltingEligible()` (el
  código que decide si se muestra el aviso de verdad) es exactamente el
  mismo antes y después de esta entrega, carácter por carácter.

Cuando el piloto real aporte etiquetas reales y el modelo se reentrene y
valide sobre ellas, activar el gate real es cambiar una condición en
`tracking.js` — la infraestructura de puntuación, persistencia y umbral
configurable ya queda lista.

## 3. Qué se agregó

### Migración `007_motor_decision_riesgo.sql`

- `campaigns.risk_threshold NUMERIC(4,3)` (0..1, default `0.500`): umbral
  configurable por campaña, igual de editable que
  `jolting_probability` ya lo era.
- `deliveries.risk_score NUMERIC(6,5)`, `risk_would_trigger BOOLEAN`,
  `risk_scored_at TIMESTAMPTZ`, `risk_model_version TEXT` (hash del
  `.onnx` usado, para poder distinguir corridas de modelos futuros),
  `risk_score_error TEXT` (motivo cuando no se pudo puntuar, p. ej. sin
  captura conductual todavía).

Todas las columnas nuevas son nullable/con default — ninguna fila ni
código existente se ve afectado por la migración.

### `apps/api/src/lib/riskScore.js` (nuevo)

El núcleo de la feature: una **reimplementación deliberada en JavaScript**
de `ml/src/preprocess.py` + `ml/src/features.py` (normalización por
viewport, resampleo a 25 Hz, suavizado por promedio móvil, construcción de
las secuencias `(dt,dx,dy)` de mouse y `(dwell,flight)` de teclado), más
la carga y ejecución del mismo archivo `.onnx` vía `onnxruntime-node`.

No es una reinterpretación libre: existe precisamente para producir el
mismo resultado que el pipeline de Python, y así se verificó (sección 4).
Expone:

- `scoreBehaviorEvents(events, viewportW, viewportH)` — puro, sin DB; useful
  para tests.
- `scoreAndStoreDeliveryRisk(deliveryId)` — busca la sesión conductual más
  reciente de fase `message` para ese envío, sus eventos, calcula el
  puntaje, lo compara contra `risk_threshold` de la campaña, y actualiza
  la fila de `deliveries`. Si falta la sesión, los eventos, o falla la
  inferencia, guarda el motivo en `risk_score_error` en vez de reventar.

### Enganche en `GET /t/:token/d/:deliveryId/go` (`tracking.js`)

Único cambio a este handler:

```js
res.on("finish", () => {
  scoreAndStoreDeliveryRisk(d.delivery_id).catch((err) => {
    console.error(`[riskScore] fallo calculando riesgo para delivery ${d.delivery_id}:`, err);
  });
});
```

`res.on("finish", …)` dispara el cálculo **después** de que la respuesta
ya se envió por completo al participante — la página señuelo no espera ni
un milisegundo por el modelo. El resto del handler (`joltingEligible`,
`interventionAlreadyShown`, `recordOnce`) es idéntico al de antes de esta
entrega.

### Endpoints nuevos

- `PATCH /api/campaigns/:id/risk-threshold` — igual de simple que
  `PATCH /api/campaigns/:id/jolting`: valida `threshold` entre 0 y 1 y lo
  guarda.
- `GET /api/dashboard/risk-summary` — agrega por grupo (control/
  experimental), nunca por participante: ataques totales, cuántos se
  pudieron puntuar, cuántos con error, riesgo promedio, cuántos el gate de
  sombra habría mostrado, y cuántos mostraron el aviso de verdad (columna
  independiente, contada desde el evento `intervencion_mostrada`) — para
  poder comparar "lo que el modelo habría hecho" contra "lo que
  realmente pasó" sin mezclar ambas señales en una sola cifra.

### Panel de administración

- Paso 2 (Campaña): nuevo bloque "Motor de decisión por riesgo (§8.2.5,
  modo sombra)" junto al de probabilidad del aviso, con su propio campo de
  umbral y botón de guardar — mismo patrón visual e interacción que el
  campo de probabilidad ya existente.
- Paso 5 (Resultados): nueva tabla "Motor de decisión por riesgo" con la
  salida de `risk-summary` por grupo, etiquetada explícitamente como
  "modo sombra — no gatea nada real" para que quien mire el panel no la
  confunda con una medición del comportamiento real de la intervención.

## 4. Verificación

**Paridad numérica cruzada (Python↔JavaScript, onnxruntime-python↔onnxruntime-node).**
`ml/scripts/gen_risk_fixture.py` corre el pipeline real de Python
(`preprocess_mouse_samples`, `mouse_sequence`, `keystroke_sequence`) más el
`.onnx` committeado, sobre una sesión de mouse/teclado fija, y graba cada
valor intermedio y el resultado final
(`apps/api/tests/fixtures/risk_score_fixture.json`). Los tests de
`riskScore.js` cargan ese fixture y comparan: la reimplementación en JS
del preprocesamiento, la ejecución del **mismo** archivo `.onnx` vía
`onnxruntime-node`, y el resultado final. Coinciden a precisión de punto
flotante — `risk_logit = -1.0738661289215088`,
`risk_score = 0.2546685488781178`, idénticos en ambos lenguajes y ambos
runtimes.

Esta verificación encontró un bug real en el primer intento: mi
`resampleUniform` generaba la rejilla de tiempo acumulando `v += step` en
un bucle, mientras que `numpy.arange` (usado en Python) calcula el número
de puntos como `ceil((stop-start)/step)` y genera cada valor como
`start + i*step` — dan resultados distintos exactamente en los bordes de
punto flotante, y con eso el pipeline en JS producía un punto de más en la
rejilla. Se corrigió reescribiendo `resampleUniform` con el mismo cálculo
basado en conteo que usa `numpy.arange`.

**Tests unitarios (`apps/api/tests/unit/riskScore.test.js`, 20 tests):**
casos de valor conocido para resampleo/suavizado/normalización, y los 4
tests de paridad contra el fixture, incluyendo un caso degenerado (mouse y
teclado vacíos, no debe reventar).

**Tests de integración (`apps/api/tests/integration/risk-score.test.js`,
7 tests, contra Postgres real):**

1. `PATCH risk-threshold` valida el rango 0..1 y persiste el valor.
2. Una campaña nueva trae `risk_threshold = 0.5` por defecto.
3. Captura conductual real posteada a `/t/:token/behavior`, seguida de
   `GET /go`, calcula y guarda `risk_score`/`risk_would_trigger`/
   `risk_model_version` en segundo plano (poll con `waitFor`).
4. `GET /go` sin ninguna captura conductual no revienta, y guarda un
   `risk_score_error` explicativo en vez de un puntaje.
5. El cálculo de riesgo no retrasa la respuesta al participante — se
   dispara después de responder (< 300ms de latencia, cálculo confirmado
   después vía poll).
6. **Aislamiento del modo sombra**: con `jolting_probability = 0`, el
   aviso nunca sale, sin importar el `risk_score` calculado — la prueba
   más directa de que el gate de sombra no gatea nada real todavía.
7. `GET /api/dashboard/risk-summary` agrega por grupo, nunca una fila por
   participante.

**Suite completa:** `npm test` en `apps/api` — **86/86** tests pasan
(79 previos + 7 nuevos de integración; los 20 unitarios de `riskScore` ya
estaban incluidos en los 79). Corrida dos veces seguidas, sin fallos ni
flakiness. Suite de Python (`ml/`, `python3 -m pytest`) — **48/48**, sin
cambios respecto a la entrega anterior (este módulo no toca `ml/src/`).

## 5. Hallazgo incidental: `event_type` desactualizado en `schema.sql`

Durante la depuración de esta feature (una serie de cuelgues aparentes en
tests preexistentes que en un primer momento parecían causados por el
código nuevo) se encontró que `db/schema.sql` define
`CREATE TYPE event_type AS ENUM (...)` con la lista **original** de
valores, sin `'intervencion_mostrada'` ni `'intervencion_cancelada'` —
que la migración `003_paws_intervention.sql` agrega vía
`ALTER TYPE event_type ADD VALUE`. Una instalación fresca que solo
corriera `schema.sql` (sin aplicar las migraciones) tiene el tipo
`event_type` incompleto: el proceso de Node revienta con
`invalid input value for enum event_type: "intervencion_mostrada"` en el
primer clic sobre un mensaje de ataque con jolting activo, y desde afuera
eso se ve como si el servidor "se colgara" (las peticiones siguientes
nunca reciben respuesta de un proceso que ya murió).

Es un bug preexistente, no introducido por esta entrega, pero se corrigió
aquí por ser un cambio de una línea con causa raíz clara y evidencia
directa de reproducción: se actualizó el `CREATE TYPE` de `schema.sql`
para incluir los dos valores que la migración 003 ya agregaba en
cualquier base de datos migrada correctamente.

## 6. Qué no cambia y límites

- El aviso que ve el participante sigue decidiéndose **exclusivamente**
  por `jolting_probability`/`jolting_roll` (migración 006) — verificado
  directamente por el test de aislamiento (sección 4, punto 6). Esta
  entrega no mueve esa decisión ni un poco.
- El puntaje de riesgo depende de que exista una sesión de captura
  conductual de fase `message` para ese envío; sin ella (por ejemplo, un
  cliente con JavaScript deshabilitado, poco realista pero posible) el
  campo queda con `risk_score_error` en vez de un número — nunca revienta
  la petición del participante.
- El modelo sigue entrenado sobre etiquetas 100% sintéticas
  (`docs/2026-09-06_pipeline-ml-offline.md` §4,
  `docs/2026-09-07_preprocesamiento-conductual.md` §5). El puntaje que se
  guarda ahora es real y reproducible bit a bit respecto al pipeline de
  Python, pero lo que *significa* ese número sigue sujeto a esa
  limitación — por eso modo sombra, no gate real.
- `risk_model_version` guarda el hash sha256 del `.onnx` usado en cada
  puntuación, para poder distinguir sin ambigüedad los puntajes de este
  modelo de los de una versión reentrenada en el futuro (con etiquetas
  reales), sin tener que recalcular nada retroactivamente.
