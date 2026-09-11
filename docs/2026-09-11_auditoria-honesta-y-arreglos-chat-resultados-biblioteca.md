# 2026-09-11 — Auditoría honesta del proyecto, y tres arreglos funcionales reales (chat, resultados del admin, biblioteca de ataques)

## 1. Contexto

Después de entregar el patch 0016 (rediseño + prioridad/checklist + plantillas de chat), el usuario
reportó que no percibía nada nuevo funcionando de verdad: ni el diseño, ni el chat, ni "los valores
ni los ataques en el panel del admin". Pidió además un criterio explícito, con nota del 1 al 10 por
módulo, sobre si el proyecto ya tiene todo lo necesario para medir/recolectar/procesar/evaluar los
datos, o si falta algo y hay que arreglarlo.

Se hizo una auditoría real del código (no una relectura de lo ya documentado) para separar tres
cosas distintas que estaban mezcladas en el reclamo:

1. Código que sí está construido y funciona, pero cuyo efecto es sutil o no se nota sin comparar
   antes/después (el retinte de colores, por ejemplo).
2. Código que se construyó en el patch anterior pero tenía un **defecto real** que lo hacía sentir
   "que no funciona" — se encontraron dos, descritos abajo, y se corrigieron en este patch.
3. Trabajo que genuinamente **no existe todavía** — el más importante es el pipeline de Machine
   Learning (extracción de features desde datos reales, modelos base, arquitectura TCN+Transformer,
   exportación a ONNX, evaluación) — y no se puede "arreglar" en un rato: es la parte más grande que
   queda pendiente del proyecto completo.

## 2. Bug real #1 — el chat no tenía con qué responder un ataque sin salir de él

### Diagnóstico

`lib/chat.js` (`loadThreadMessages`, la función que arma lo que ve el participante en `/chat.json`)
nunca traía el árbol de respuestas (`message_branches`) de un ataque insertado en el chat. El
mecanismo de branching (elegir un botón de respuesta rápida prediseñado, que crea el siguiente
mensaje de la conversación) sí funciona y está probado — pero **solo para un ataque que llega por
correo**, porque la tarjeta de mensaje de la bandeja (`renderMessage` en `decoy.js`) sí arma esos
botones a partir de `msg.branches`. Un ataque que llega por **chat** mostraba la burbuja con el
asunto y un botón "Abrir", sin ningún botón de respuesta dentro del propio chat: para contestar,
había que salir del chat, ir a la tarjeta de la bandeja, y ahí sí aparecían las opciones.

Esto explica exactamente la sensación de "el chat no funciona": el mecanismo de branching existe y
funciona, pero la superficie de chat en sí no tenía manera de mostrarlo — no era un bug visual, era
un dato que nunca viajaba desde el backend hacia esa vista en particular.

### Fix

- `lib/chat.js`: `loadThreadMessages` ahora trae, para cada mensaje de tipo `attack`, sus ramas
  disponibles (una sola consulta con `IN` sobre los templates presentes en el hilo, no una consulta
  por mensaje). Un ataque ya contestado (existe otro mensaje del hilo cuyo `parent_message_id`
  apunta a él) deja de ofrecer las mismas ramas, para que no se pueda "contestar" el mismo ataque
  dos veces y generar ataques de seguimiento duplicados.
- `decoy.js`: la burbuja de un ataque de chat ahora renderiza un bloque "Responder:" con un botón
  por rama, igual que la tarjeta de la bandeja. Un método nuevo del componente Alpine del chat
  (`chooseBranch`) llama a la misma ruta `POST /d/:deliveryId/branch` que ya existía, y si el
  servidor agregó un ataque nuevo al hilo (`appended_to_chat: true`), recarga el hilo para
  mostrarlo — todo sin navegar fuera del chat.

### Verificación

Prueba de integración extendida (`interaction.test.js`, el mismo test de chat de la migración 010):
ahora confirma que `chat.json` trae la rama definida sobre el ataque, y que después de seguirla el
ataque original deja de traer ramas (ya contestado) mientras el nuevo ataque insertado se agrega al
mismo hilo. Suite completa: **114/114**.

Smoke test end-to-end contra un servidor real: se armó un guion de chat con un ataque de vector
"urgencia" (plantilla de kind `chat`) con una rama definida hacia un segundo ataque, se le entregó a
un participante real, y se verificó con Playwright que:

- El botón "Sí, lo confirmo ahora" aparece directamente en la burbuja del ataque, dentro del chat.
- Al hacer clic, el botón desaparece del ataque original y el siguiente ataque de la rama
  ("Actividad inusual: tu sesión se cerrará en 10 minutos") aparece agregado al mismo hilo, en la
  misma pantalla, sin recargar.

## 3. Bug real #2 — el admin no mostraba los ataques por técnica ni por rol

### Diagnóstico

`GET /api/dashboard/overview` calcula desde hace tiempo dos desgloses agregados de los ataques:
`por_tecnica` (autoridad/urgencia/escasez/prueba_social/curiosidad) y `por_rol`
(estudiante/profesor/directivo), reusando la función `attackMetricsSQL`. El panel admin
(`admin.js`, `loadResults()`) ya pedía este endpoint completo para pintar las 4 tarjetas de resumen
del paso 5 — pero **nunca leía `por_tecnica` ni `por_rol` de la respuesta**: esos dos campos
llegaban al navegador y se descartaban sin pintarse en ningún lado. Es la explicación literal de
"no veo los valores ni los ataques en el panel del admin": esos valores existían, pero nunca
llegaban a la pantalla.

### Fix

Se agregó un panel nuevo, "Ataques por técnica y por rol", en el paso 5 · Resultados, con dos
tablas que consumen exactamente los campos `por_tecnica`/`por_rol` que el endpoint ya devolvía.

### Verificación

Smoke test con Playwright: tras entregar un ataque real a un participante, el panel muestra la fila
correspondiente (técnica "urgencia", rol "estudiante") con sus conteos reales — confirmando que el
dato fluye de punta a punta y no es un valor de ejemplo.

## 4. Biblioteca de ataques extendida: de 15 a 25 plantillas de ataque

### Diagnóstico

El pedido original incluía explícitamente "mejora la parte de los mensajes de ataque, extiéndelos".
En el patch anterior se amplió la **estructura** (el nuevo formato "chat directo"), pero el
**contenido** de la biblioteca estándar (`STANDARD_LIBRARY` en `templates.js`) se quedó exactamente
igual: 3 plantillas de ataque por técnica (15 en total) desde antes de esta entrega. Eso es
consistente con el reclamo de "todo lo que tiene es lo que ya existe, no se le agrega nada nuevo" —
en ese punto específico, tenía razón.

### Fix

Se agregaron 2 plantillas de ataque nuevas por cada una de las 5 técnicas (10 en total: 25
plantillas de ataque + las 6 de relleno de siempre = 31), usando solo mecanismos que ya existen (sin
tocar esquema): los 3 formatos (`email`/`task`/`chat`) y los 2 tipos de página trampa
(`form`/`permiso`). De las dos plantillas nuevas por técnica, una es siempre de formato **chat
directo** — antes de esta entrega la biblioteca estándar no traía ninguna plantilla de ese formato,
así que "Crear biblioteca estándar" en el paso 3 nunca dejaba nada listo para usar en un guion de
chat (paso 6); ahora sí: cada técnica tiene al menos una plantilla de chat lista para insertar.

Los "otros tipos de ataque" más ambiciosos (SMS real, adjuntos simulados, un login corporativo
genérico de alta fidelidad, dificultad adaptativa) siguen siendo la propuesta de
`docs/2026-09-09_diversificacion-vectores-ataque.md`, que requiere columnas y landing types nuevos
— una decisión de alcance aparte, no algo que convenga mezclar con esta extensión de contenido
dentro de lo que ya existe.

### Verificación

`admin.test.js` (`seed-defaults crea la biblioteca estándar`) se actualizó para verificar, contra la
base de datos real, que cada técnica tiene exactamente 5 plantillas de ataque y al menos una de
formato `chat`. Suite completa: 114/114.

## 5. Auditoría honesta por módulo (1–10)

Calificación basada en inspección directa del código y, donde aplicó, verificación en vivo — no en
la documentación que se fue generando sobre la marcha. "10" significa: construido, probado con
Postgres real (no mocks), y sin gaps conocidos. Números más bajos indican gaps concretos, listados
en la columna de la derecha.

| # | Módulo | Nota | Por qué |
|---|---|---|---|
| 1 | Participantes (import CSV, roles, equipos) | 9 | Sólido, probado, sin gaps conocidos. |
| 2 | Campañas, enlaces, consentimiento, calibración | 9 | Sólido, probado, es la columna vertebral de todo el flujo. |
| 3 | Biblioteca de plantillas de ataque (contenido) | 7 | Se dobló de 15 a 25 esta entrega; sigue siendo contenido "de catálogo cerrado", sin dificultad adaptativa ni variables de contexto (ver doc de diversificación). |
| 4 | Envío y entrega de mensajes (deliveries, jolting adaptativo) | 9 | Real, con sorteo determinista y reproducible, probado. |
| 5 | Páginas trampa (form/permiso) y credenciales de práctica | 8 | Real y seguro (nunca guarda lo escrito), probado. |
| 6 | Árbol de respuestas sobre correo | 8 | Funciona y está probado desde la migración 010. |
| 7 | Chat de equipo (guion, ataques inyectados, respuesta libre, branching) | **7** (antes 4) | El mecanismo de fondo era sólido, pero la superficie de chat no ofrecía los botones de respuesta — corregido en este patch y verificado con Playwright. |
| 8 | TaskFlow — diseño y estructura (Kanban, panel fusionado) | 7 | Reconstruido esta entrega (paleta, tipografía, panel con pestañas); funciona, pero es la parte con menos historial de uso real y sin pruebas automatizadas de frontend. |
| 9 | Panel admin — cobertura de rutas backend | 8 | Casi todas las rutas del backend tienen ya una pantalla en `/admin.html`. |
| 10 | Panel admin — visibilidad de resultados/valores | **7** (antes 4) | Los desgloses por técnica/rol existían en el backend pero nunca se pintaban — corregido en este patch. |
| 11 | Captura conductual real (mouse/teclado) | 8 | Real, tested, exportable a CSV. |
| 12 | Motor de riesgo (modo sombra) / jolting adaptativo | 7 | Funciona y compara contra lo real, pero "modo sombra" significa que **todavía no decide nada real** — es un dato de análisis, no una función terminada end-to-end. |
| 13 | **Pipeline de Machine Learning** (features reales, baselines, TCN+Transformer, ONNX, evaluación) | **3** | Ver sección 6 — es, con diferencia, lo más incompleto del proyecto. |
| 14 | Seguridad/privacidad (RLS, anonimización, no-PII) | 9 | Consistente en todo el proyecto, con un incidente real ya encontrado y corregido en producción. |
| 15 | Documentación | 9 | Extensa y con justificación de cada decisión. |
| 16 | Pruebas automatizadas de backend | 9 | 114/114, contra Postgres real, sin mocks. Cero pruebas automatizadas de frontend (`admin.js`/`decoy.js`) — verificación manual con Playwright únicamente. |

**Promedio simple: ~7.6/10.** Pero un promedio esconde lo importante acá: los módulos 1–12 y 14–16
(la "máquina de simulación": entregar ataques, medir clics/caídas/reportes, capturar biometría,
proteger los datos) están sólidos. El módulo 13 (el pipeline de ML que convierte esa biometría en un
puntaje de riesgo entrenado y evaluado de verdad) es la excepción — y es, según los propios
comentarios del código ("TG §8.2.1", "TG §8.2.5"), una parte central del trabajo de grado.

## 6. Respuesta directa: ¿ya está todo lo necesario para medir/recolectar/procesar/evaluar los datos?

**No, todavía no.** Separando las cuatro palabras del pedido:

- **Medir y recolectar**: sí, esto está resuelto y es real. La captura conductual
  (`behavior-capture.js`, `behavior_sessions`/`behavior_events`) registra mouse y teclado de verdad,
  sin mocks, con export a CSV.
- **Procesar**: parcial. Existe `behaviorFeatures.js` (features reales: AUC/SE/MD de mouse,
  latencias de tecleo, z-score contra calibración) y corre como job bajo demanda desde el admin —
  pero es un cálculo de features aislado, no un pipeline completo de entrenamiento.
- **Evaluar**: **no**. Según la lista de tareas de esta sesión (que sigue vigente), lo que falta es:
  extracción de datos reales desde producción hacia el pipeline offline, los modelos base
  (SVM/RF/XGBoost) para tener un punto de comparación, la arquitectura moderna propuesta
  (TCN + Transformer con fusión por atención), su exportación a ONNX para que el runtime del
  servidor la use en producción (`riskScore.js` ya sabe cargar un `.onnx`, pero el modelo que carga
  hoy sigue entrenado con **etiquetas sintéticas**, no con datos reales evaluados), y un reporte de
  evaluación real con sus métricas. Nada de eso está construido todavía — son las tareas 20 a 28 del
  plan de trabajo, y solo la primera (extraer los datos reales) está en curso.

Es decir: el proyecto sí junta el dato correcto, de la forma correcta, con las protecciones
correctas — pero el paso final de "evaluar" (entrenar y validar un modelo real contra ese dato, y
reportar qué tan bien funciona) es la pieza más grande que falta, y es probablemente el corazón del
trabajo de grado, no un detalle menor.

## 7. Qué sigue

Dos caminos posibles a partir de acá, y conviene decidir cuál antes de seguir para no mezclar
alcance:

1. **Seguir profundizando la app de simulación** (contenido de ataques más variado con dificultad
   adaptativa, terminar de conectar el modo sombra del motor de riesgo a una decisión real, más
   pulido visual del tablero) — mejoras reales, pero incrementales sobre algo que ya funciona.
2. **Construir el pipeline de ML** (tareas 20–28: extracción real, baselines, arquitectura
   TCN+Transformer, ONNX, evaluación) — es la pieza que hoy tiene la nota más baja de esta
   auditoría, y muy probablemente lo que más se necesita para poder decir que el trabajo de grado
   "mide, recolecta, procesa y evalúa" de punta a punta.

## 8. Archivos modificados en este patch

- `apps/api/src/lib/chat.js` — `loadThreadMessages` trae las ramas de cada ataque de chat.
- `apps/api/src/lib/decoy.js` — botones de respuesta rápida dentro de la burbuja de chat;
  `chooseBranch` en el componente Alpine del chat.
- `apps/api/src/routes/templates.js` — 10 plantillas de ataque nuevas (2 por técnica, una de ellas
  siempre `kind: "chat"`).
- `apps/api/public/admin.html` — panel nuevo "Ataques por técnica y por rol" en el paso 5.
- `apps/api/public/admin.js` — `renderAttackBreakdown()` pinta `por_tecnica`/`por_rol`.
- `apps/api/tests/integration/interaction.test.js` — verifica que el chat trae y suprime ramas.
- `apps/api/tests/integration/admin.test.js` — verifica el tamaño y formato de la biblioteca
  extendida.
