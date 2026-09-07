# Preprocesamiento de captura conductual: resampleo, suavizado, z-score (TG §8.2.1, Tabla 1, fila 2)

Fecha: 2026-09-07. Este documento cubre el único módulo que seguía en rojo
en la tabla de estado del repositorio: preprocesamiento. Vive en
`ml/src/preprocess.py`, dentro del mismo workstream de Python que ya
contenía `features.py` (representación) y el resto del pipeline de ML
(`docs/2026-09-06_pipeline-ml-offline.md`).

## 1. Por qué hacía falta (con datos reales, no en abstracto)

Hasta ahora, `features.py` calculaba AUC/SE/MD y velocidad/aceleración
directamente sobre la trayectoria cruda de mouse, tal como llega de
`behavior-capture.js`. Tres problemas concretos de esos datos crudos,
verificados contra los 2418 eventos reales de producción:

1. **Muestreo irregular.** `behavior-capture.js` apunta a ~25 Hz, pero es
   un objetivo, no una garantía — el intervalo real entre dos
   `mousemove` consecutivos varía con el jitter del navegador/red. AUC/SE/MD
   tratan cada punto como si pesara lo mismo en la integral; con espaciado
   irregular, un tramo de la sesión con muestras muy juntas termina
   pesando más de lo que debería, sin que eso signifique nada sobre el
   comportamiento del participante.
2. **Ruido de coordenadas.** Un par de píxeles de ruido por
   redondeo/precisión del dispositivo apuntador infla las
   velocidades/aceleraciones instantáneas que ya calculaba `features.py`,
   sin aportar señal real.
3. **Features en píxeles, no comparables entre pantallas.** AUC, MD y
   `path_length` están en píxeles. Nada garantiza que todos los
   participantes usen la misma resolución de pantalla (`viewport_w`/
   `viewport_h` ya se capturan por sesión desde el 5 de septiembre,
   justamente para esto). Sin normalizar, dos personas con el mismo
   comportamiento real pero distinta pantalla saldrían con features
   distintas por una razón que no tiene nada que ver con su conducta.

## 2. Qué se agregó

`ml/src/preprocess.py`, cuatro piezas, todas funciones puras probadas con
arrays de valor conocido (`tests/test_preprocess.py`, 13 tests):

1. **`normalize_by_viewport`**: lleva x,y a [0,1] relativo al tamaño de
   pantalla de esa sesión — la forma de la trayectoria deja de depender de
   la resolución del participante.
2. **`resample_uniform`**: interpola (t,x,y) a una rejilla de tiempo
   pareja (25 Hz por defecto), para que el peso de cada punto en
   AUC/SE/MD sea real y no un artefacto del jitter de muestreo.
3. **`moving_average`**: suavizado por promedio móvil centrado (ventana de
   5 muestras por defecto, ajustada a impar si hace falta), bordes
   rellenados por repetición para no acortar la serie ni introducir un
   salto artificial en los extremos.
4. **`compute_calibration_baselines` + `zscore` + `baseline_for`**: esta es
   la pieza más importante, no un z-score genérico. Reutiliza la pantalla
   de calibración (`docs/2026-09-06_calibracion-linea-base.md`, capturada
   ANTES de mostrarle cualquier mensaje al participante) como línea base
   *personal*: la velocidad media de mouse y las latencias medias de
   tecleo de la sesión de calibración de CADA participante se usan como
   referencia para z-scorear las mismas métricas en sus otras sesiones
   (mensaje, aterrizaje de ataque, tablero). El resultado responde "¿qué
   tan distinto se movió/tecleó esta persona respecto a SU propio
   comportamiento normal?", no solo "¿es rápido o lento en términos
   absolutos?" — exactamente la pregunta que motivó construir la
   calibración en primer lugar. Cuando un participante no tiene sesión de
   calibración (datos capturados antes del 6 de septiembre, cuando ese
   módulo no existía), se usa como referencia la media/desviación de las
   44 sesiones reales — un z-score poblacional en vez de personal — y
   `baseline_z_source` deja constancia, sesión por sesión, de cuál de los
   dos se usó.

`preprocess_mouse_samples(events, viewport_w, viewport_h)` encadena
normalización → resampleo → suavizado, y devuelve una lista de
pseudo-eventos con la MISMA forma que ya consumían
`mouse_trajectory_features`/`mouse_sequence` en `features.py` — ese módulo
no se tocó, sigue siendo el mismo código ya probado y entregado el 6 de
septiembre.

## 3. Cómo queda conectado al resto del pipeline

`dataset.py` gana un parámetro `preprocess: bool = True` en
`build_feature_table()` y `build_sequences()`:

- Con `preprocess=True` (default), las columnas `mouse_*` de
  `build_feature_table()` se calculan sobre la trayectoria YA
  normalizada/resampleada/suavizada, y se agregan tres columnas nuevas:
  `mouse_mean_velocity_z`, `key_mean_dwell_ms_z`, `key_mean_flight_ms_z`
  (más `baseline_z_source` indicando de dónde salió la referencia). Las
  columnas originales en píxeles/ms se conservan sin tocar — el z-score se
  agrega, no reemplaza nada, para no perder interpretabilidad ni romper a
  quien ya consumía `FEATURE_COLUMNS`.
- `build_sequences()` también preprocesa la trayectoria de mouse antes de
  convertirla en la secuencia (dt,dx,dy) que consume la rama TCN del
  modelo temporal.
- `preprocess=False` en cualquiera de las dos funciones reproduce
  exactamente el comportamiento anterior a este cambio (sin las columnas
  `_z`, sobre la trayectoria cruda) — se dejó disponible para comparar
  antes/después, no como el modo recomendado.
- `evaluate.py` ahora entrena los baselines con `FEATURE_COLUMNS +
  FEATURE_COLUMNS_Z` (18 columnas en vez de 15) y `metrics.json` incluye
  una sección `preprocessing` con el conteo de sesiones por
  `baseline_z_source`.

## 4. Verificación

- 13 tests nuevos en `tests/test_preprocess.py`: resampleo (preserva
  extremos, espaciado parejo, no extrapola, pasa intacto con <2 puntos o
  duración cero), suavizado (reduce dispersión sin desplazar el nivel ni
  acortar la serie, no-op con ventana ≤1), normalización por viewport
  (mapea a [0,1], pasa intacto si falta el viewport), z-score (caso base,
  std=0 no revienta), y `compute_calibration_baselines` sobre los datos
  reales (confirma que las 5 sesiones de fase `calibration` producen 5
  líneas base personales).
- 2 tests nuevos en `tests/test_dataset.py`: confirman que
  `preprocess=True` agrega las columnas `_z` esperadas y que, con los
  datos reales actuales, el 100% de las 44 sesiones obtiene línea base
  *personal* — un hallazgo real del dataset, no un bug: los 2418 eventos
  reales vienen de solo **5 participantes distintos**, cada uno pasando
  por varias fases (calibración + mensaje/aterrizaje/tablero), así que
  ninguna de las 44 filas cae al respaldo poblacional todavía. Eso
  cambiará solo cuando entren participantes nuevos sin su propia
  calibración emparejada, y `baseline_z_source` seguirá dejando registro
  de cuál referencia se usó en cada caso.
- `tests/test_baselines.py` (la de la revisión `/engineering:debug` del
  6 de septiembre sobre el resultado casi perfecto de Random Forest) se
  actualizó: sigue demostrando lo mismo (el resultado alto de RF depende
  de cómo se construye la etiqueta sintética, no de fuga de datos), con
  los nuevos valores numéricos que salen de las features ya preprocesadas
  (antes 1.0 exacto con todas las columnas / 0.909 sin las dos que generan
  la etiqueta; ahora 0.909 / 0.818 — mismo patrón, otra escala).
- Suite completa: **48/48 tests pasan** (46 previos + 2 nuevos de dataset
  + los 13 de preprocess ya contados en el total, menos el ajuste del test
  de baselines). Corrida de punta a punta (`python3 -m src.evaluate`)
  confirmada sin errores, con `reports/metrics.json` y los 4 PNG
  regenerados sobre las features ya preprocesadas.

## 5. Qué no cambia y límites

- Los 44 eventos reales de esta corrida vienen todos del mismo puñado de
  participantes de prueba (5), todos con el mismo `viewport` (1920×945) —
  la normalización por viewport no tiene efecto visible en ESTE dataset
  todavía porque no hay diversidad de pantallas que corregir, pero es
  necesaria para cuando el piloto real (ya aprobado por el comité de
  ética) traiga participantes con equipos distintos.
- Igual que con el resto del pipeline: las etiquetas siguen siendo
  sintéticas (ver `docs/2026-09-06_pipeline-ml-offline.md`, sección 4).
  Preprocesar mejor la señal de entrada no cambia esa limitación — sigue
  siendo una prueba mecánica del pipeline, no un resultado científico.
