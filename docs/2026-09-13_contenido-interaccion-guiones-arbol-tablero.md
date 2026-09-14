# Contenido de interacción: guiones de chat, ataques por canal, árbol de respuestas, plantillas de tablero

**Fecha:** 13 de septiembre de 2026
**Disparador:** pedido explícito del usuario — la biblioteca estándar (paso 3) y el módulo de interacción (paso 6) tenían muy poco contenido de ejemplo: 25 ataques pero solo 6 mensajes de relleno benigno, ningún árbol de respuestas sembrado por defecto, y solo 2 plantillas de tablero. Una bandeja tan desbalanceada hacia el ataque, sin variedad de canal ni ruido benigno realista, no se siente como el entorno de trabajo real que el piloto necesita simular (TG §8.2.6).

## 1. Ataques por canal (`apps/api/src/routes/templates.js`)

Antes, cada uno de los 5 vectores tenía 3 plantillas de correo, 1 de tarea y 1 de chat — "ataques por canal" en el panel admin (`dashboard.js`, `por_canal` agrupa por `messages.kind`) quedaba desbalanceado hacia correo. Se agregaron **11 plantillas nuevas** (1-2 por vector, priorizando tarea y chat) para que cada vector tenga ahora al menos 2 de cada canal:

| Vector | Correo | Tarea | Chat |
|---|---|---|---|
| Autoridad | 3 | 2 | 2 |
| Urgencia | 3 | 2 | 2 |
| Escasez | 3 | 2 | 2 |
| Prueba social | 3 | 2 | 2 |
| Curiosidad | 4 | 2 | 2 |

Cada plantilla nueva reutiliza el mismo mecanismo persuasivo del vector pero con un pretexto distinto a los ya existentes (ej. Autoridad ya tenía "Soporte TI" y "RRHH"; la nueva es "Cumplimiento y Auditoría") — así una campaña real puede alternar pretextos sin repetir, igual que pasa con ataques de phishing reales.

La biblioteca estándar pasó de **25 a 36 ataques**.

## 2. Relleno realista (34 mensajes nuevos, 40 en total)

Se agregaron 34 mensajes benignos (`is_attack: false`) puramente informativos: mantenimiento, boletines, recordatorios de RRHH, cambios de horario, jornadas de bienestar, actualizaciones de plantillas, etc. Deliberadamente sin presión de tiempo ni de escasez — el contraste de tono con los ataques es intencional: parte de lo que se mide en la encuesta post-sesión (`recognized_as_simulated`, `perceived_suspicion_before_action`) es si el participante distingue el ataque del ruido normal de una bandeja de trabajo, y una bandeja con solo 6 mensajes benignos frente a 25 de ataque no ofrecía suficiente ruido para que esa distinción significara algo.

La biblioteca estándar pasó de **31 a 76 plantillas totales** (36 ataque + 40 relleno).

## 3. Árbol de respuestas de ejemplo (nuevo, `POST /api/templates/branches/seed-defaults`)

Antes, `message_branches` (la tabla que decide a qué plantilla lleva cada botón de respuesta rápida — migración 010) no tenía ninguna semilla de un clic, a diferencia de compañeros, plantillas de tablero y guiones de chat, que sí la tenían. Un admin que quisiera un árbol de respuestas tenía que armarlo a mano, plantilla por plantilla, desde el panel.

Se agregó un endpoint nuevo, **global** (no por campaña, igual que `templates`), con 10 respuestas de ejemplo (2 por vector) que encadenan dos plantillas del mismo vector y del mismo canal — nunca se mezcla correo/tarea con chat, porque una rama que sale de un mensaje de chat se sigue agregando al mismo hilo (`POST /:token/d/:deliveryId/branch` en `tracking.js`), y un cuerpo con formato HTML pensado para bandeja no se vería bien ahí. Ejemplo: sobre "Autoridad — Soporte TI: verificación obligatoria", la respuesta "Ahora no, lo reviso más tarde" lleva a un segundo correo, "Autoridad — Legal: firma pendiente de la política interna" — la misma presión de autoridad, un pretexto distinto, como pasaría en una campaña real de varios contactos.

Idempotente por `(from_template_id, action_key)`, igual que el endpoint manual ya existente. Requiere que la biblioteca estándar (paso 3) ya esté creada — si falta alguna plantilla, esa respuesta en particular reporta el error en vez de fallar todo el lote.

Botón agregado en el panel admin, panel "Árbol de respuestas" (paso 6), junto al selector manual ya existente.

## 4. Plantillas de tablero (2 → 5)

Se agregaron 3 plantillas de tablero nuevas ("Onboarding de nuevo integrante", "Migración de servidor", "Campaña de bienestar del trimestre"), con el mismo elenco de `DEFAULT_CONTACTS`, misma estructura de columnas/prioridad/checklist que las 2 originales — para que el participante no vea siempre el mismo escenario de ejemplo al crear su primer tablero.

## 5. Guiones de chat: sin cambios de código

El generador de guiones (`POST /campaigns/:id/chat-scripts/seed-defaults`) ya crea **un guion por cada plantilla de ataque "chat directo" que exista** (no una lista fija) — con las 5 plantillas de chat nuevas de la sección 1, este mismo botón ahora genera **10 guiones** en vez de 5, sin tocar el código del generador. Se prefirió esto a enriquecer el generador (por ejemplo, con varios turnos de conversación ambiente antes del ataque) para no arriesgar la lógica ya probada del guion automático ni sus pruebas existentes; sigue siendo una mejora pendiente si se quiere más adelante.

## 6. Verificación

Pruebas actualizadas: `admin.test.js` (conteos 36/40 en vez de 25/6, diversidad ≥2 tarea y ≥2 chat por vector), `interaction.test.js` (total de plantillas de tablero 2→5, prueba nueva para el árbol de respuestas: crea, verifica un caso concreto por nombre, e idempotencia). Suite completa verificada en verde: **131/131** (una segunda corrida, ya que la primera mostró la falla de orden compartido ya documentada en `group-assignment.test.js`, ajena a este cambio — confirmado corriendo ese archivo solo, 11/11 en verde).
