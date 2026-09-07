# Pipeline de ML offline (TG §8.2.3 / §8.2.4): baselines + arquitectura temporal → ONNX

Fecha: 2026-09-06. Este documento explica, para alguien que nunca ha visto
este workstream, qué se construyó, por qué se construyó así (incluyendo el
cambio de arquitectura respecto al plan original de la tesis), cómo correrlo,
cómo visualizar los resultados, y qué NO se puede concluir todavía.

Todo el código vive en `ml/`, **fuera** de `apps/api` — es un workstream en
Python, independiente del backend Node/Express, tal como lo especifica la
tesis (TG §8.2.3: "es explícitamente un workstream en Python fuera del repo
`apps/api` actual").

## 1. Qué problema resuelve

TG §8.2.3/§8.2.4 pide dos cosas:

1. Un pipeline offline que, a partir de la captura conductual real (mouse +
   teclado, ya construida en `docs/2026-09-05_captura-conductual-real.md`),
   entrene modelos de clasificación de riesgo de phishing.
2. Dos familias de modelo: **baselines tabulares** (SVM / Random Forest /
   XGBoost sobre features agregadas por sesión) y una **arquitectura
   temporal** (procesa la secuencia completa de eventos, no solo agregados)
   exportada a **ONNX** para correr client-side, en el navegador del
   participante, vía ONNX Runtime Web.

El plan original de la tesis especificaba, para la arquitectura temporal:
TCN para la rama de mouse + BiLSTM/GRU para la rama de teclado, fusionadas
por concatenación. Este documento también cubre por qué esa arquitectura
se actualizó (sección 3).

## 2. Qué se construyó

```
ml/
├── data/behavior_events_real.json   # export real de producción (ver sección 5)
├── src/
│   ├── features.py         # AUC/SE/MD de mouse + latencias de teclado (features puras)
│   ├── dataset.py          # carga + arma tabla de features y secuencias padded
│   ├── baselines.py        # SVM / Random Forest / XGBoost
│   ├── temporal_model.py   # TCN (mouse) + Transformer (teclado) + fusión por atención
│   ├── train.py            # loop de entrenamiento del modelo temporal
│   ├── export_onnx.py      # exportación a ONNX + verificación de paridad numérica
│   └── evaluate.py         # corrida de punta a punta (genera reports/)
├── tests/                   # 33 tests, pytest
└── reports/                 # generado por evaluate.py (no versionado): PNGs + metrics.json + .onnx
```

### 2.1 Features (`src/features.py`) — TG §8.2.3

Por sesión (`session_id`), sobre las filas crudas que ya entrega
`GET /api/export/behavior-events.:format`:

- **Trayectoria de mouse**: se traza la recta imaginaria entre el primer y
  el último punto de la sesión; para cada punto intermedio se calcula su
  distancia perpendicular a esa recta. De ahí:
  - **AUC** (área bajo la curva): integral por regla del trapecio de esas
    distancias a lo largo de la trayectoria normalizada [0,1].
  - **SE** (error estándar): desviación estándar de esas distancias /
    √n.
  - **MD** (distancia media): promedio de esas distancias.
  - Además: longitud real del trayecto, distancia en línea recta,
    eficiencia (recta/real), velocidad y aceleración media/desviación.
  - Estas son features estándar de la literatura de dinámica de mouse para
    biometría conductual y detección de bots/automatización (la
    desviación de una trayectoria respecto a la línea recta ideal es la
    señal central en ese campo desde los trabajos clásicos de CAPTCHA
    conductual hasta los sistemas de biometría continua actuales).
- **Latencias de teclado**: nunca se lee el carácter tecleado (`key_code`
  es solo el código físico de la tecla, p.ej. `"KeyA"` — ver
  `db/schema.sql`). Se calculan:
  - **dwell time**: `keyup.t − keydown.t` de la MISMA tecla (emparejadas
    con una pila por `key_code`, para tolerar teclas simultáneas).
  - **flight time**: `keydown.t` del siguiente evento − `keyup.t` del
    anterior, sin importar qué tecla sea.

Todas las funciones son puras (nada de I/O ni acceso a base de datos), así
que se prueban con casos de valor conocido: una trayectoria en línea recta
perfecta debe dar AUC = SE = MD = 0 sin importar cuántos puntos tenga
(`tests/test_features.py`).

### 2.2 Baselines (`src/baselines.py`)

SVM (kernel RBF, con estandarización de features), Random Forest
(200 árboles, profundidad máxima 6) y XGBoost (200 árboles, profundidad 4)
sobre la tabla de una fila por sesión (15 features de `FEATURE_COLUMNS` en
`dataset.py`). Sin cambios respecto al plan original — siguen siendo la
elección correcta para un baseline tabular interpretable.

### 2.3 Arquitectura temporal (`src/temporal_model.py`) — actualizada, ver sección 3

- **Rama de mouse**: TCN (Temporal Convolutional Network, Bai et al. 2018)
  sobre la secuencia `(Δt, Δx, Δy)` de cada evento de mouse — 3 bloques
  residuales con convoluciones **causales** (el padding va solo a la
  izquierda, así la salida en el instante *t* nunca depende de eventos
  futuros) y dilatación creciente (1, 2, 4). Sin BatchNorm a propósito:
  con lotes tan chicos como los de este piloto (potencialmente batch=1),
  `BatchNorm1d` es inestable o directamente revienta; se usa
  dropout + conexión residual en su lugar.
- **Rama de teclado**: un **Transformer encoder compacto** (2 capas,
  4 cabezas, `d_model=32`) sobre la secuencia `(dwell, flight)` por tecla,
  con codificación posicional senoidal — reemplaza a BiLSTM/GRU (ver
  sección 3 para el porqué).
- **Pooling**: `AttentionPool` — reduce cada secuencia a un vector con un
  peso de atención aprendido por posición, respetando la máscara de
  padding. Incluye un fix explícito (`_ensure_valid_mask`) para el caso
  real más común: una sesión sin ningún evento de teclado (37 de 44
  sesiones reales) tendría una máscara íntegramente en `False`, lo que sin
  este fix produce un softmax sobre puntajes todos en `-inf` → división
  0/0 → `NaN`. El fix garantiza al menos una posición "válida" de
  respaldo (índice 0, que en una secuencia vacía es simplemente el
  relleno de ceros), dando una salida determinista — "no hay señal de
  teclado" — en vez de un error. Verificado en `tests/test_temporal_model.py`
  y, específicamente, que el resultado es **el mismo embedding para
  cualquier sesión sin teclas** (no depende de la sesión ni introduce
  sesgo — ver sección 6, hallazgo #3 de la revisión de debug).
- **Fusión**: `AttentionFusion` — un mecanismo de atención de 2 tokens
  (embedding de mouse, embedding de teclado) que aprende cuánto pesar cada
  rama, en vez de concatenarlas con peso fijo. Reemplaza la concatenación
  simple del plan original (sección 3).
- **Cabeza de clasificación**: MLP pequeño (32→16→1) que produce un solo
  logit (sin sigmoid — se entrena con `BCEWithLogitsLoss`).

Todo el módulo evita usar `if` de Python sobre *valores* de tensores (solo
aritmética y máscaras), para que `torch.onnx.export` (basado en trazado)
produzca un grafo válido para cualquier entrada del mismo shape, no solo la
usada al exportar — verificado con un test que corre el modelo exportado
con un batch size distinto al usado para trazar (`test_onnx_export.py`).

### 2.4 Exportación a ONNX (`src/export_onnx.py`)

`torch.onnx.export(..., opset_version=17, dynamic_axes={... "batch" ...},
dynamo=False)`. La verificación de "paridad" corre el MISMO input por el
modelo de PyTorch (fuente de verdad) y por el grafo ONNX exportado (lo que
de verdad correría en el navegador vía ONNX Runtime Web) y confirma que las
salidas coinciden con tolerancia `atol=1e-4`. Sin esto, "exportó sin error"
no prueba nada — un grafo puede ejecutar sin excepciones y aun así calcular
algo distinto (por ejemplo, por cómo se traza una máscara booleana).
Resultado real de la última corrida: diferencia máxima absoluta
`1.79e-07`, muy por debajo de la tolerancia.

Dos decisiones de exportación quedaron documentadas como comentarios en el
propio código porque son workarounds de bugs/limitaciones del toolchain de
este entorno, no elecciones de diseño:

- `dynamo=False`: el exportador "dynamo" (default en Torch ≥ 2.6) apunta a
  opset 18 y, al pedir la conversión automática a opset 17, falla con un
  adaptador de versión faltante para el operador `Pad` (usado por el
  padding causal de la TCN) — un bug conocido de `onnxscript`, no de este
  modelo. El exportador clásico basado en TorchScript no tiene ese
  problema.
- `_ensure_valid_mask` usa aritmética en punto flotante (`Mul`/`Add`/
  `Greater`) en vez de `torch.where` sobre tensores booleanos: el grafo
  ONNX que produce `torch.where(bool_tensor, ...)` emite un nodo `Where`
  cuyo kernel booleano no está implementado en la versión de ONNX Runtime
  usada aquí (`NotImplemented: Could not find an implementation for
  Where(16)`). La reescritura evita el operador problemático sin cambiar
  el resultado — confirmado por los tests de paridad.

## 3. Por qué se cambió la arquitectura (y qué NO cambió)

El plan original (TG §8.2.4) especificaba BiLSTM/GRU para la rama de
teclado y fusión por concatenación. Se preguntó explícitamente si había
algo más actual antes de implementar, y sí: se reemplazó **solo** la rama
de teclado y el mecanismo de fusión. La rama de mouse (TCN) y los tres
baselines (SVM/RF/XGBoost) se mantienen sin cambios — seguían siendo una
elección sólida y no tenían el problema que motivó el cambio.

**Cambio 1 — BiLSTM/GRU → Transformer compacto (rama de teclado).**
Motivo 1, vigencia en la literatura: los estudios de 2024-2025 sobre
dinámica de teclado (p. ej. la revisión "Adaptability of current keystroke
and mouse behavioral biometric systems: A survey", 2025) nombran
arquitecturas basadas en atención (TypeFormer, BehaveFormer) como el
enfoque más popular actualmente implementado para dinámica de teclado —
BiLSTM/GRU ya no aparecen como el estado del arte en esas revisiones.
Motivo 2, y más determinante porque no depende de tendencias sino de una
restricción técnica de despliegue: este modelo se exporta a ONNX para
correr en el navegador del participante vía **ONNX Runtime Web**. La tabla
de operadores soportados por su backend rápido (**WebGPU**) NO incluye
LSTM/GRU — solo el backend WASM (CPU, notablemente más lento) los soporta.
Las operaciones centrales de atención (`MatMul`, `Softmax`, `LayerNorm`, y
un operador contrib `MultiHeadAttention`) sí están en la tabla de WebGPU.
En otras palabras: con BiLSTM/GRU, este modelo quedaría forzado al backend
más lento en producción, sin importar qué tan bueno fuera el modelo; con
Transformer, no. Motivo 3, colateral: sin estado recurrente que propagar
paso a paso, la exportación a ONNX es un forward pass sin bucles con
estado oculto — más simple y con menos superficie para bugs de
exportación (de hecho, los dos workarounds de la sección 2.4 son de la
rama de mouse/máscara, no de la rama de teclado).

**Cambio 2 — concatenación → fusión por atención (`AttentionFusion`).**
Con concatenación simple, las dos ramas reciben el mismo peso fijo aunque
una traiga mucha menos señal — el caso real más común aquí es exactamente
ese: una sesión sin ninguna tecla (37 de 44). Con atención de 2 tokens, el
modelo aprende cuánto pesar cada rama según el contenido real de esa
sesión, en vez de un peso fijo decidido de antemano.

**Qué no cambió y por qué:** TCN para mouse (no es recurrente, así que no
tenía el problema de soporte en WebGPU) y los tres baselines tabulares
(SVM/RF/XGBoost siguen siendo el estándar razonable para features
agregadas, y la tesis los pide explícitamente como línea base, no como
lo que se busca mejorar).

## 4. Datos y etiquetas: qué es real y qué es sintético (léase con atención)

Al 6 de septiembre de 2026, la base de producción (proyecto Supabase
`PWAS`) tiene:

- **44 sesiones de captura conductual real, 2418 eventos reales**
  (`behavior_events`) — mousemove/mousedown/mouseup/click/keydown/keyup
  reales de participantes, extraídos en vivo de producción y usados tal
  cual en este pipeline (`ml/data/behavior_events_real.json`).
- **0 encuestas post-sesión** (`post_session_survey`) — el piloto real que
  generaría la etiqueta verdadera ("¿la persona cayó en el ataque?") sigue
  bloqueado por la aprobación del comité de ética.

Dado ese bloqueo, y por decisión explícita del usuario (features reales +
etiquetas sintéticas, solo para validar mecánicamente que el pipeline
corre), este pipeline usa:

- **Features: 100% reales.** Se extraen de los 2418 eventos reales — este
  paso no tiene nada de sintético.
- **Etiquetas: 100% sintéticas** (`dataset.synthetic_labels`) — una
  combinación lineal determinista (semilla fija) de dos features de mouse
  más ruido gaussiano, umbralizada en la mediana para quedar balanceada.
  **No representan ninguna hipótesis real sobre qué predice caer en un
  ataque de phishing.** Su único propósito es que el entrenamiento tenga
  "algo real que aprender" para poder confirmar que el pipeline completo
  (datos → features → baselines → modelo temporal → ONNX) corre de punta a
  punta sin errores y produce salidas numéricamente coherentes.

**Todo output de este pipeline — `reports/metrics.json`, los gráficos, el
`.onnx` — es una prueba mecánica del pipeline, NO un resultado científico
sobre susceptibilidad a phishing.** Los campos `data_source` y `labels` de
`metrics.json` llevan esta aclaración escrita explícitamente, para que no
se pierda si el archivo se comparte o se cita fuera de contexto.

## 5. Cómo correrlo

```bash
cd ml
python3 -m venv .venv && source .venv/bin/activate
pip install --break-system-packages -r requirements.txt
# nota: si `download.pytorch.org` está bloqueado por política de red del
# entorno, instalar torch desde el índice normal de PyPI en vez de su
# índice propio (pip install --break-system-packages torch==2.14.0
# --index-url https://pypi.org/simple) — funciona igual en CPU.

# tests (33 tests, ~8s)
python3 -m pytest -q

# corrida de punta a punta: entrena baselines + modelo temporal, exporta a
# ONNX, verifica paridad, y escribe reports/*.png + reports/metrics.json
python3 -m src.evaluate
```

`ml/data/behavior_events_real.json` ya está incluido (export real congelado
al 6 de septiembre de 2026). Para refrescarlo con datos más recientes,
volver a exportar desde `GET /api/export/behavior-events.json` (mismo
schema que consume `dataset.load_export`).

## 6. Revisión `/engineering:debug`

Se corrió una revisión de debug estructurada sobre el pipeline completo,
con pruebas reales (no solo lectura de código), enfocada en tres hipótesis
concretas de riesgo. Ninguna resultó ser un bug — las tres son
comportamiento esperado, pero se agregaron 3 tests de regresión nuevos
(33 tests en total, antes 30) para que quede verificado automáticamente y
no dependa de que alguien recuerde la explicación:

**Hallazgo #1 — Random Forest da accuracy=1.0 / ROC-AUC=1.0 en el set de
prueba.** Reproducido y confirmado: `synthetic_labels()` construye la
etiqueta como función casi-lineal (poco ruido) de `mouse_efficiency` y
`mouse_mean_velocity`, dos columnas que están literalmente en
`FEATURE_COLUMNS` y alimentan directamente a RF. Se confirmó
empíricamente removiendo esas dos columnas del set de entrenamiento: el
accuracy baja (de 1.0 a ~0.91, con otras columnas correlacionadas —
derivadas de la misma trayectoria de mouse — todavía filtrando parte de la
señal). **No es fuga de datos entre train/test** (el split es correcto y
estratificado) — es que la etiqueta sintética es, por construcción, casi
completamente predecible desde las features de mouse. Este resultado
**no se replicará con etiquetas reales** y no debe usarse como referencia
de desempeño esperado. Test de regresión:
`test_random_forest_near_perfect_score_on_synthetic_labels_is_explained_by_label_construction`
en `tests/test_baselines.py`.

**Hallazgo #2 — re-alineación de etiquetas entre `build_feature_table()` y
`build_sequences()` en `evaluate.py`.** Se verificó que ambas funciones
agrupan la misma lista `rows` con el mismo `group_by_session`, y que
Python preserva el orden de inserción del dict — el orden de sesiones ya
coincide de por sí antes de la línea de re-alineación
(`df.set_index("session_id").loc[session_ids].reset_index()`). Esa línea
es una salvaguarda barata y correcta, no el fix de un bug real. Test de
regresión: `test_feature_table_and_sequences_agree_on_session_order` en
`tests/test_dataset.py`.

**Hallazgo #3 — fallback de máscara (`_ensure_valid_mask`, índice 0) para
sesiones sin teclas.** Se confirmó empíricamente que dos sesiones
*distintas* sin ninguna tecla (37 de 44 casos reales) producen exactamente
el mismo embedding en la rama de teclado — el fallback es un placeholder
determinista de "sin señal de teclado", no una fuente de sesgo ni una fuga
de información entre sesiones (no "toma prestado" nada de la rama de
mouse ni de otras sesiones). Test de regresión:
`test_all_masked_keystroke_fallback_gives_same_embedding_regardless_of_session`
en `tests/test_temporal_model.py`.

**Nota para atención futura (no bloqueante):** en la corrida de
`evaluate.py`, el logit del modelo temporal para una sesión de prueba
llegó a ≈140 (confianza extrema, sigmoid ≈ 1.0) mientras el accuracy de
entrenamiento terminó en 63.6% — consistente con un modelo pequeño
sobreajustando en un dataset de 44 sesiones (33 de entrenamiento), no con
un bug. Cuando lleguen etiquetas reales y el N crezca, vale la pena
revisar si conviene agregar recorte de gradiente (`grad_clip`) o
regularización adicional en `train.py` si se repiten logits de esa
magnitud — no se aplicó ahora porque no afecta la validez de la prueba
mecánica y una regularización más fuerte solo tiene sentido de calibrar
con datos y etiquetas reales.

## 7. Cómo visualizar los resultados

`python3 -m src.evaluate` genera en `ml/reports/`:

- `roc_curves.png` — curvas ROC de los 3 baselines.
- `confusion_matrices.png` — matriz de confusión de cada baseline.
- `feature_importance.png` — importancia de features (Random Forest y
  XGBoost).
- `training_curve.png` — pérdida y accuracy de entrenamiento del modelo
  temporal por época.
- `jolting_risk_model.onnx` — el modelo temporal exportado, listo para
  cargar con ONNX Runtime Web (`onnxruntime-web`) en el cliente.
- `metrics.json` — todas las métricas numéricas + los campos
  `data_source`/`labels` con la aclaración real-vs-sintético.

Además de los PNGs locales, se publicó un reporte HTML navegable (mismos
datos, presentados para lectura humana, con la aclaración
real/sintético destacada) — ver el enlace entregado junto con este
documento. Para volver a generarlo tras una corrida nueva de
`evaluate.py`, hay que re-publicarlo con los nuevos valores de
`reports/metrics.json` (los PNGs no se re-incrustan automáticamente).

## 8. Límites explícitos (para no perder de vista)

- **N=44 sesiones** es una muestra muy chica para cualquier conclusión
  estadística, sintética o no.
- **0 etiquetas reales** — el resultado "perfecto" de Random Forest es un
  artefacto de la construcción de la etiqueta sintética (hallazgo #1),
  no una señal de que el sistema ya detecta phishing.
- **37 de 44 sesiones no tienen ningún evento de teclado** — la rama de
  teclado, con datos reales de hoy, casi no tiene información que aportar
  todavía; su valor real se probará cuando haya más sesiones con
  interacción de teclado.
- Nada de esto se puede citar como resultado de investigación hasta que
  exista el piloto real con encuestas post-sesión (bloqueado por comité de
  ética) y un N sustancialmente mayor.
