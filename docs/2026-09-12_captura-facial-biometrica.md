# Captura biométrica facial (extensión fuera del alcance original)

**Fecha:** 12 de septiembre de 2026
**Disparador:** el investigador pidió agregar un módulo que tome datos biométricos faciales para medir el estado de duda/hesitación de los participantes, usando las herramientas propuestas en su tesis.

## 1. Por qué esto es una EXTENSIÓN, no una implementación directa de la tesis

El documento de metodología compartido en esta misma conversación (TG §8.2 "Diseño de ingeniería del sistema PAWS (Fase 1 implementable)" y capítulo IX "Diseño experimental") describe explícitamente una Fase 1 acotada a captura de **mouse y teclado** — la Tabla 1 de §8.2.1 lista mouse/teclado como la única fila de "captura conductual", y §8.2.6 (Tarea B) y §8.2.8 dejan cualquier sensor biométrico adicional (incluida cámara/rostro) para una Fase 2 explícitamente fuera de este alcance, sujeta a su propia aprobación ética.

Antes de escribir una sola línea de este módulo, se confrontó esa contradicción directamente con el investigador (citando los pasajes concretos), y se preguntó dos cosas por separado:

1. **¿Alcance:** ¿agregar cámara aunque no esté en el documento compartido? → Confirmado que sí.
2. **¿Ética real:** ¿el comité de ética aprobó captura de cámara/rostro, y no solo mouse/teclado? → Confirmado que **el comité aprobó la captura de cámara/rostro por separado**.

Este documento (y el código que describe) existen solo porque ambas confirmaciones se dieron explícitamente. Sin la segunda en particular, este módulo no se habría construido — activar la cámara de una persona es una sensibilidad de otro orden que registrar mouse/teclado, y no es algo que deba asumirse a partir de una aprobación de alcance distinto.

## 2. Qué mide y cómo

Usando **MediaPipe FaceLandmarker** (Google, procesamiento 100% en el navegador vía WebAssembly — ningún frame de video sale nunca del dispositivo del participante), se derivan, ~15 veces por segundo, 5 señales simples a partir de los 52 blendshapes ARKit-compatibles que produce el modelo:

- **Apertura ocular** (`eye_openness`, 0-1): `1 - promedio(eyeBlinkLeft, eyeBlinkRight)`.
- **Parpadeo** (`blink`, booleano): apertura ocular por debajo de un umbral (0.4) en esa muestra.
- **Mirada horizontal/vertical** (`gaze_x`, `gaze_y`): proxy simple combinando los blendshapes `eyeLookIn/Out/Up/Down` de ambos ojos — sirve para detectar aversión/fijación de mirada, no es un eye-tracker calibrado.
- **Tensión de ceja** (`brow_tension`, 0-1): promedio de `browDownLeft`, `browDownRight`, `browInnerUp` (ceño fruncido).
- **Tensión de boca** (`mouth_tension`, 0-1): promedio de `mouthPressLeft/Right` y `mouthStretchLeft/Right`.

Estas 5 señales son la combinación que el investigador pidió explícitamente (parpadeo + apertura ocular + fijación/aversión de mirada, combinadas con tensión de ceja/boca) — no una elección unilateral de este lado.

**Nunca se guarda ni se envía**: video, imágenes, los 478 landmarks 3D, ni los 52 blendshapes crudos. Solo los 5 escalares de arriba, por muestra. Es el mismo invariante de privacidad que ya regía `behavior_events.key_code` (la tecla física, nunca el carácter) — llevado al dominio facial: se guarda la señal mínima necesaria para el análisis, nunca la fuente de la que se deriva.

## 3. Arquitectura (deliberadamente calcada de la captura conductual — migraciones 004/008)

| Pieza | Captura conductual (ya existía) | Captura facial (esta migración) |
|---|---|---|
| Migración | 004 + 008 | **015** |
| Sesión cruda | `behavior_sessions` | `facial_sessions` |
| Muestra cruda | `behavior_events` | `facial_events` |
| Features agregadas | `behavior_session_features` | `facial_session_features` |
| Script del navegador | `public/js/behavior-capture.js` | `public/js/facial-capture.js` |
| Cálculo de features | `lib/behaviorFeatures.js` | `lib/facialFeatures.js` |
| Recálculo por lote | `POST /api/dashboard/recompute-features` | `POST /api/dashboard/recompute-facial-features` |
| Export crudo | `GET /api/export/behavior-events.csv` | `GET /api/export/facial-events.csv` |
| Export features | `GET /api/export/session-features.csv` | `GET /api/export/facial-features.csv` |

No es una convención nueva porque no hacía falta una: el mismo patrón de dos capas (crudo + agregado), sesión generada por el navegador (`crypto.randomUUID()`), `t_ms` relativo, y línea base de calibración personal-o-poblacional, ya resolvía exactamente este problema para mouse/teclado.

**Diferencia deliberada:** el consentimiento. `participants.camera_consent_given` es un campo **separado** de `consent_given` — se pide en la misma pantalla de bienvenida pero con su propio checkbox, no obligatorio, y nunca se asume a partir del consentimiento general. El servidor defiende esto en dos capas: `facialCaptureTag()` (decoy.js) ni siquiera emite la etiqueta `<script>` si `camera_consent_given` no es `TRUE` (el navegador nunca pide permiso de cámara), y `POST /:token/facial` (tracking.js) descarta en silencio cualquier lote si ese consentimiento no está, por si acaso.

**Transparencia activa, no solo un checkbox inicial:** mientras la cámara está en uso, `facial-capture.js` inyecta un aviso fijo y visible ("🎥 Captura facial activa") en el que el propio participante puede hacer clic para pausar/reanudar la captura en cualquier momento de la sesión — el consentimiento inicial no agota su derecho a interrumpirla.

## 4. Por qué NO se integra al motor de riesgo en tiempo real

`riskScore.js` (migración 007) calcula, en modo sombra, un puntaje de riesgo a partir de mouse/teclado para cada clic en un ataque. Deliberadamente, las señales faciales **no** se agregan a ese cálculo:

- No existe un modelo entrenado que combine responsablemente mouse+teclado+rostro — el motor actual es un puerto de fórmulas ya validadas en `ml/` sobre mouse/teclado únicamente. Añadir señales faciales sin una validación equivalente sería inventar un criterio de decisión no probado, exactamente el error que la migración 007 documentó evitar (ver `docs/2026-09-07_motor-decision-riesgo.md`).
- El propio capítulo IX del documento de la tesis (§9.6-9.7, LOSO cross-validation) describe el entrenamiento de modelos como un proceso OFFLINE en Python, sobre datos ya recolectados — no algo que deba improvisarse en el camino crítico de una petición HTTP.

Este módulo es, entonces, exactamente lo que es la captura conductual: **almacenamiento para análisis offline**, exportable a CSV para el pipeline de `ml/`, sin gatear ni cambiar nada del flujo real del participante.

## 5. Fuentes técnicas verificadas (no asumidas)

Para no enviar al participante una URL de modelo o una versión de librería inventadas:

- `@mediapipe/tasks-vision@1.0.1` — versión `latest` confirmada contra el registro de npm en el momento de escribir esto.
- Modelo `face_landmarker.task` (variante `float16`) — URL (`storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`) confirmada contra el código fuente de la muestra oficial de Google (`google-ai-edge/mediapipe-samples-web`, `src/tasks/face-landmarker.ts`), no contra la página de documentación (que deliberadamente no publica esta URL, remitiendo a "tu propio modelo alojado").

## 6. Pendiente

- Aplicar la migración 015 en producción (Supabase `ihemxqzuolhmkwikhnlg`) — pendiente al momento de escribir esto.
- Aplicar el parche correspondiente sobre el repositorio del usuario y desplegarlo — no se puede hacer `git push` desde este entorno.
- Las 5 fórmulas de señal (§2) son heurísticas razonables sobre blendshapes, no unidades FACS validadas clínicamente ni calibradas contra un instrumento de referencia — quedan documentadas así en la cabecera de `facial-capture.js` y `facialFeatures.js` para que cualquier publicación derivada de estos datos las describa con esa misma precisión.
