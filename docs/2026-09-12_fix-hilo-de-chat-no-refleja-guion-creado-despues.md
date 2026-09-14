# Fix: un guion de chat creado después de probar no se veía reflejado

**Fecha:** 12 de septiembre de 2026
**Disparador:** el usuario reportó, probando en producción, que llenó el guion de chat en el paso 6 · Interacción, el sistema dijo que se guardó, pero al volver a entrar como participante no aparecía nada — y que en general no tenía claro qué hace ese módulo.

## 1. Diagnóstico

Se confirmó contra la base de producción que el guion sí se había guardado bien (`chat_script_templates`, 1 fila, con sus dos pasos correctos). El problema no era de guardado — era de cuándo se "aplica" ese guion a un participante concreto.

`getOrCreateThread` (`apps/api/src/lib/chat.js`) crea el hilo de chat de un participante **una sola vez**, la primera vez que esa persona abre la vista de chat: en ese momento copia los pasos del guion vigente a `chat_messages`. Si en ese momento la campaña todavía no tenía guion (como en este caso: el usuario cargó 20 participantes e hizo una prueba abriendo el chat *antes* de armar el guion en el paso 6), el hilo queda creado y vacío — y **nada** vuelve a tocarlo después. Crear o editar un guion más tarde no tiene ningún efecto sobre los hilos que ya existen.

Se verificó con las marcas de tiempo reales de producción: los hilos de chat de los participantes `p001` y `p002` se crearon a las 05:40, y el guion "Revisa" se creó recién a las 05:45 — cinco minutos después. Por eso "decía que se guardó" (cierto) pero "no se veía en la prueba" (también cierto, y va a seguir pasando indefinidamente sin este fix).

Esto explica también la parte de "no entiendo lo que está haciendo": no había ninguna indicación en la pantalla de que el módulo es por campaña, ni de que abrir el chat "congela" su contenido para esa persona.

## 2. Arreglo

- **`apps/api/src/routes/campaigns.js`**: tanto `POST /api/campaigns/:id/reset` (reinicia toda la campaña) como `POST /api/campaigns/:id/participants/:pcId/reset` (reinicia uno) ahora también borran el hilo de chat del participante (`resetChatThreads`), junto con los mensajes de ataque por chat que ese hilo haya generado — son copias propias por participante, no la plantilla compartida, así que borrarlos es seguro. Así, "Reiniciar" (que ya existía como botón para volver a probar) también hace que el chat se re-arme desde cero con el guion vigente.
- **`apps/api/public/admin.html`**: se agregó una nota visible al entrar al paso 6 explicando en lenguaje llano qué hace el módulo (ambientación de TaskFlow, por campaña) y, en particular, que si ya se probó el chat antes de configurar esto hay que usar "Reiniciar" en el paso 2 · Enlaces para que el cambio se vea.
- **Prueba nueva** en `apps/api/tests/integration/tracking.test.js`: reproduce exactamente el bug real (abrir el chat, crear el guion después, confirmar que sigue vacío) y confirma que `Reiniciar` lo corrige. Suite completa: 116/116, corrida dos veces.

## 3. Remediación inmediata en producción

Mientras se prepara el despliegue de este fix, se corrigió a mano el estado ya afectado en producción (proyecto Supabase `ihemxqzuolhmkwikhnlg`): se borraron los hilos de chat vacíos de `p001` y `p002` (los únicos dos participantes que habían abierto el chat antes de que existiera el guion), siguiendo el mismo procedimiento que ahora hace `resetChatThreads` automáticamente. La próxima vez que cualquiera de los dos entre a su enlace y abra el chat, el sistema lo va a armar de nuevo — esta vez sí con el guion "Revisa" ya cargado.

## 4. Pendiente

Este fix vive únicamente en el código de la API (sin cambios de esquema, no requiere migración). Sigue pendiente lo de siempre: aplicar el parche correspondiente sobre el repositorio del usuario y desplegarlo — no se puede hacer `git push` desde este entorno.
