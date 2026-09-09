# Etiquetado fino: features por sesión persistidas en Postgres (TG §8.2.1 Tabla 1, módulo 7)

Fecha: 2026-09-09. Este documento cubre el módulo que quedaba en amarillo en
la tabla de estado del repositorio: "Almacenamiento (eventos, etiquetas,
resultados)" — parcial porque solo guardaba eventos gruesos y captura
conductual cruda, sin el etiquetado fino que dependía de que los módulos 2-3
(preprocesamiento, representación) estuvieran listos. Lo estaban desde
`docs/2026-09-07_preprocesamiento-conductual.md`.

## 1. Por qué hacía falta

Desde la migración 004 (`docs/2026-09-05_captura-conductual-real.md`),
`behavior_events` guarda la captura CRUDA: una fila por muestra de mouse o
tecla. Eso alcanzaba para exportar un CSV y correr el pipeline de ML en
Python (`ml/src/`), pero las features REALES por sesión — AUC/SE/MD de la
trayectoria de mouse, latencias de tecleo, y sus z-scores contra la línea
base de calibración de cada participante — solo existían mientras ese
pipeline corría, en memoria de un proceso Python aparte. Para ver esas
features desde el panel admin o cruzarlas con otra tabla había que exportar
el CSV crudo y volver a correr Python cada vez; no quedaba nada persistido
en esta base de datos. Esa era exactamente la brecha que dejaba "parcial"
al módulo 7 de la Tabla 1.

## 2. Qué se agregó

### Migración `008_etiquetado_fino.sql`

Una tabla nueva, `behavior_session_features`: una fila por
`behavior_sessions.id`, con exactamente las columnas de `FEATURE_COLUMNS` +
`FEATURE_COLUMNS_Z` de `ml/src/dataset.py` — el mismo conjunto de features
que ya entrena los baselines tabulares (SVM/RF/XGBoost) — más
`baseline_z_source` ("personal"/"poblacional") y `feature_version`.

### `apps/api/src/lib/behaviorFeatures.js` (nuevo)

Un **puerto deliberado a JavaScript** de `ml/src/features.py`
(`mouse_trajectory_features`, `keystroke_features`) y `ml/src/preprocess.py`
(`compute_calibration_baselines`, `zscore`, `baseline_for`) — mismo criterio
que ya se usó para el motor de riesgo (`apps/api/src/lib/riskScore.js`,
`docs/2026-09-07_motor-decision-riesgo.md`): no es una reinterpretación
libre, tiene que producir los mismos números que Python para el mismo
input, y reutiliza directamente `preprocessMouseSamples` de `riskScore.js`
(ya escrito y verificado) en vez de portarlo dos veces.

Expone las funciones puras (`mouseTrajectoryFeatures`, `keystrokeFeatures`,
`computeCalibrationBaselines`, `baselineFor`, `zscore`) y una integración con
Postgres, `recomputeSessionFeatures({campaignId})`, que:

1. Trae todos los eventos crudos (de toda la base, o de una campaña si se
   pasa `campaignId`) con el mismo `JOIN` que ya usa
   `GET /api/export/behavior-events.csv`.
2. Agrupa por sesión y calcula la línea base de calibración de todo el
   conjunto (`computeCalibrationBaselines`) — igual que
   `compute_calibration_baselines` en Python: una entrada "personal" por
   participante con sesión de fase `calibration`, más una entrada
   `"__population__"` sobre TODAS las sesiones, para las demás.
3. Calcula las features de cada sesión y las guarda con
   `INSERT ... ON CONFLICT (session_id) DO UPDATE`, dentro de una
   transacción (`withTransaction`, ya existente en `db.js`) — o quedan
   todas las filas de esta pasada, o ninguna.

### Por qué es un job por lote, no algo automático en cada evento

A diferencia del motor de riesgo (migración 007), que calcula un puntaje en
el momento del clic porque tiene que decidir algo (aunque sea en modo
sombra) sobre ESE clic concreto, aquí no hay ninguna decisión en tiempo
real que tomar. Además, una sesión de captura no tiene una señal de
"cerrada" — el navegador solo hace flush periódico — y la línea base de
calibración de cada participante se calcula comparando contra TODO el
conjunto de sesiones a la vez: recalcularla en cada lote de 300 muestras
sería trabajo repetido sin ganar nada. Por eso el recálculo se dispara a
pedido (`POST /api/dashboard/recompute-features`), el mismo criterio que ya
usa correr `python3 -m src.evaluate` a mano.

### Endpoints nuevos

- `POST /api/dashboard/recompute-features` (body opcional
  `{campaign_id}`): recalcula y persiste. Devuelve `{computed, campaign_id}`.
- `GET /api/dashboard/features-summary?campaign_id=`: agregado por
  `phase` — sesiones totales vs. con features calculadas, promedios de
  AUC/velocidad/dwell, y conteo de línea base personal vs. poblacional.
  Nunca una fila por participante.
- `GET /api/export/session-features.:format` (`json`/`csv`): una fila por
  sesión con sus features, más rol/grupo/equipo del participante — igual
  criterio de privacidad que el resto de exports (`participant_campaign_id`,
  nunca `external_hash`).

### Panel de administración

Paso 5 ("Resultados"), un panel nuevo "Features por sesión (etiquetado
fino, §8.2.3)" entre la captura conductual cruda y el motor de riesgo: un
botón para calcular las features de la campaña activa, una tabla resumen
por pantalla, y un botón para descargar el CSV — mismo patrón visual que
los paneles de captura conductual y riesgo ya existentes.

## 3. Verificación

**Paridad numérica con Python.** `ml/scripts/gen_features_fixture.py`
genera tres sesiones sintéticas pensadas para ejercitar ambos caminos de
`baseline_for`:

- `sess-calib-pcA` (fase `calibration`, participante `pcA`) → se vuelve su
  línea base **personal**.
- `sess-msg-pcA` (fase `message`, MISMO participante `pcA`) → debe usar esa
  línea base personal.
- `sess-msg-pcB` (fase `message`, participante `pcB` SIN calibración) → debe
  caer al respaldo **poblacional** (calculado sobre las 3 sesiones, calibración
  incluida — igual que en Python).

El fixture (`apps/api/tests/fixtures/behavior_features_fixture.json`) graba
las features de mouse/teclado y los z-scores que Python calculó de verdad
con `ml/src/features.py`/`ml/src/preprocess.py`. Los tests de
`behaviorFeatures.js` reproducen esos mismos números — a diferencia del
puerto del motor de riesgo (que necesitó una corrección de
`resampleUniform`), este puerto coincidió con Python en el primer intento;
aun así, la única forma de confirmarlo sin asumirlo es esta comparación
número a número, no una lectura del código.

**Tests unitarios** (`apps/api/tests/unit/behaviorFeatures.test.js`, 14
tests): casos de valor conocido (línea recta perfecta → AUC=SE=MD=0; un par
de teclas simple → dwell/flight exactos; `safeMeanStd` usa desviación
POBLACIONAL — ddof=0 — a propósito distinta de la MUESTRAL — ddof=1 — que
usan `mouse_trajectory_features`/`keystroke_features`, igual que en Python)
más los 5 tests de paridad contra el fixture.

**Tests de integración** (`apps/api/tests/integration/behavior-features.test.js`,
6 tests, contra Postgres real): recálculo end-to-end con captura conductual
real posteada por HTTP; línea base personal confirmada con un participante
que sí tiene sesión de calibración; línea base poblacional confirmada con
uno que no; idempotencia (recalcular dos veces actualiza la misma fila, no
duplica); `features-summary` agregado por fase sin fugar identidad
individual; y el export CSV con las columnas esperadas y sin
`external_hash`.

**Suite completa:** **106/106** tests en `apps/api` (86 previos + 20 nuevos:
14 unitarios + 6 de integración). Corrida tres veces; en una de ellas falló
`group-assignment.test.js` ("force:true reasigna...") — la misma
flakiness preexistente y ya documentada en
`docs/2026-09-06_concurrencia-y-botones-asignacion-grupo.md`/entregas
posteriores (colisión de estampa `Date.now()` entre archivos de test
corriendo a máxima velocidad), no relacionada con este módulo; las otras
dos corridas dieron 106/106 limpio. Suite de Python: no se tocó ningún
archivo de `ml/src/`, solo se agregó el script de fixture — la suite sigue
en 48/48 sin necesidad de revalidación (nada que pudiera haber cambiado).

## 4. Qué no cambia y límites

- Esto es almacenamiento para análisis, no una decisión: no gatea la
  intervención (eso lo sigue haciendo `jolting_roll`, migración 006) ni el
  motor de riesgo en modo sombra (migración 007) — ninguno de los dos
  cambia con esta entrega.
- Las features quedan persistidas como una FOTO del momento en que se pidió
  el recálculo. Si llegan más muestras a una sesión después de calcularla
  (por ejemplo, el navegador sigue haciendo flush), hay que volver a pedir
  el recálculo para que se actualicen — no hay una suscripción en vivo.
- La línea base poblacional se calcula sobre el conjunto de sesiones que
  entra en esa pasada (todas, o las de una campaña si se filtra) — igual
  ambigüedad que ya tiene el pipeline de Python al correr sobre un export
  acotado o completo. Con pocas sesiones (el caso actual, ~44 reales) el
  costo de recalcular todo de una vez es insignificante; si el piloto real
  trae un volumen mucho mayor, valdría la pena revisar si conviene acotar
  el recálculo por rango de fecha además de por campaña.
- El pipeline de Python (`ml/`) sigue siendo la única vía para
  entrenar/evaluar modelos (baselines tabulares, el modelo temporal). Este
  módulo no lo reemplaza ni lo toca — solo hace que las mismas features que
  ese pipeline calcula queden también disponibles aquí sin tener que
  correrlo.
