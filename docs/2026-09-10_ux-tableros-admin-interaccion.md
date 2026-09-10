# 2026-09-10 — Botón de "Nuevo tablero" invisible, panel de administración sin sección de Interacción, y accesos rápidos al chat

## 1. Contexto

Después de que el módulo de interacción ampliada (tableros reales, chat simulado, árbol de
respuestas — migración 010, ver `docs/2026-09-09_interaccion-ampliada-tableros-chat-ramas.md`)
quedó desplegado y con datos reales corriendo en producción (ver
`docs/2026-09-10_fix-rls-app-service-y-crash-async.md`), el usuario reportó cuatro problemas de
uso/diseño sobre esa misma superficie, todos en un solo mensaje:

1. En "Mis tableros" aparece el texto *"Todavía no tienes tableros. Crea el primero con 'Nuevo
   tablero'."* pero no hay ningún botón visible para crearlo.
2. En el panel admin (`/admin.html`) no hay ninguna sección para administrar los mensajes/guiones
   de chat.
3. No se ve ningún cambio reflejando "los otros tipos de ataques" que se habían diseñado.
4. No hay botones de asignación visibles ni un acceso fácil al chat de equipo, y en general "no se
   cuida el diseño ni la experiencia de usuario".

Los puntos 1, 2 y parte del 4 resultaron ser bugs/omisiones reales y concretas, confirmadas leyendo
el código fuente (no solo por el reporte del usuario). El punto 3 es un caso distinto: es una
confusión razonable entre un documento de diseño y código ya construido, que se aclara en la
sección 4 de este documento en vez de intentar adivinar qué implementar.

## 2. Diagnóstico y fix — botón "Nuevo tablero" invisible

### Causa

En `apps/api/src/lib/decoy.js`, la vista del tablero (`viewTablero`) tiene esta estructura
(Alpine.js):

```html
<div class="board-tabs" x-show="boards.length">
  <template x-for="b in boards">...</template>
  <button class="board-tab-new" @click="newBoardOpen = !newBoardOpen">Nuevo tablero</button>
</div>
```

El único botón "Nuevo tablero" vive **dentro** del contenedor `.board-tabs`, y ese contenedor tenía
`x-show="boards.length"` — es decir, Alpine lo oculta por completo (`display:none`) en cuanto
`boards.length` es `0`. Para cualquier participante que todavía no creó ningún tablero (el caso de
*todos* al empezar), el único botón para crear uno quedaba escondido junto con la barra de
pestañas que se suponía debía ocultarse — un caso de "ocultar de más": la condición estaba pensada
para no mostrar pestañas vacías, pero se llevó puesto el botón de creación con ella.

Debajo, el mensaje de estado vacío sí se mostraba correctamente
(`x-if="!boards.length && !newBoardOpen"`), lo que hacía el bug más confuso todavía: el usuario veía
la instrucción "Crea el primero con 'Nuevo tablero'" exactamente en el mismo momento en que ese
botón estaba invisible.

### Fix

Se quitó la condición `x-show="boards.length"` de `.board-tabs`. El `x-for` de adentro ya renderiza
cero pestañas cuando `boards` está vacío (no hace falta la guarda para eso), así que el único efecto
real de quitarla es que el botón "Nuevo tablero" queda siempre visible, tenga el participante cero
tableros o varios.

```diff
- <div class="board-tabs" x-show="boards.length">
+ <div class="board-tabs">
```

Verificado end-to-end contra la base de prueba: se creó una campaña, un participante, se le generó
el enlace, se completó el flujo de consentimiento + calibración, y se confirmó que el HTML servido
en `/t/:token/app?v=tablero` para un participante sin tableros ya contiene el marcado del botón
"Nuevo tablero" fuera de cualquier atributo `x-show` que lo condicione.

## 3. Fix — acceso rápido al chat desde el inicio

`viewInicio` (la pantalla de "Hola 👋" con el resumen del día) ya tenía botones de acceso directo a
"Ir a mi tablero" y "Ver la bandeja", pero ninguno al chat — a pesar de que "Chat de equipo" ya
existe como ítem completo en la navegación lateral (`VIEWS` en `decoy.js`, con su ícono y todo). Es
decir: el chat siempre fue accesible desde el riel lateral, pero la pantalla de inicio —el primer
lugar que ve cualquier participante— no lo mencionaba, lo que puede leerse como "no tiene un
espacio de fácil acceso" aunque técnicamente esté a un clic en el menú.

Se agregó un tercer botón ("Chat de equipo", con su ícono) junto a los otros dos accesos rápidos de
la pantalla de inicio, reutilizando el mismo mecanismo genérico `data-goto` que ya usan los otros
dos (no fue necesario tocar el JS de enrutado del lado del cliente, que ya resuelve cualquier
`data-goto` contra las vistas válidas).

## 4. Sobre "los otros tipos de ataque" (punto 3 del reporte)

`docs/2026-09-09_diversificacion-vectores-ataque.md` es un documento de **diseño/arquitectura**:
propone nuevos vectores (previsualizaciones tipo SMS/mensajería, simulación de adjuntos
maliciosos, páginas de aterrizaje de mayor fidelidad vía un "SSO corporativo unificado" ficticio en
vez de clonar marcas reales) pero **nunca se convirtió en código**. No hay ninguna regresión ni
ningún cambio perdido: simplemente no se llegó a construir, y por eso no hay nada nuevo que ver en
la aplicación en ese frente.

No se tomó la decisión de construir ninguno de esos vectores en esta entrega: son cambios grandes
(nuevas plantillas, nuevos tipos de aterrizaje, y en algunos casos nuevas tablas), y adivinar cuál
de las opciones del documento priorizar —sin que quien lo pidió confirme el alcance— arriesga
trabajo desperdiciado o, peor, algo que no respete las restricciones ya acordadas del proyecto (sin
suplantar marcas reales, sin texto libre interpretado por IA, etc.). Si se quiere avanzar con
alguno de esos vectores, el documento ya tiene el diseño listo para retomarlo — falta decidir cuál
construir primero.

## 5. Fix — el panel admin no tenía dónde administrar el módulo de interacción (punto 2)

### Diagnóstico

La migración 010 agregó nueve tablas nuevas (compañeros ficticios, tableros, plantillas de tablero,
hilos y guiones de chat, árbol de respuestas, credenciales de práctica) y sus rutas de
administración (`apps/api/src/routes/interaction.js`, montadas en `/api`), pero **nunca se
construyó la interfaz** para usarlas desde `/admin.html`. El panel seguía teniendo solo sus 5
pasos originales (Participantes, Campaña, Plantillas, Mensajes, Resultados); todo el backend de
interacción solo era alcanzable llamando a la API a mano. Esto no es un bug de UI rota sino un
gap de construcción completo: la funcionalidad se entregó "a medio camino" (backend sin frontend).

### Fix

Se agregó un sexto paso, **"6 · Interacción"**, en `admin.html`/`admin.js`, siguiendo las mismas
convenciones ya establecidas en el resto del panel (formularios estructurados en vez de JSON crudo,
tablas de solo lectura arriba de cada formulario, mensajes de estado inline, confirmaciones antes de
borrar). Cubre las cinco entidades del módulo:

- **Compañeros de equipo ficticios**: alta con nombre, rol y color de avatar; tabla con borrado.
- **Plantillas de tablero**: constructor de columnas → tareas (título, descripción, responsable —
  elegido de un desplegable con los compañeros ficticios ya cargados, nunca texto libre), que se
  serializa al formato `seed` que espera `POST /api/campaigns/:id/board-templates`.
- **Guiones de chat**: constructor de pasos ordenados (mover arriba/abajo, quitar), cada uno "mensaje
  del equipo" (remitente opcional + texto) o "insertar ataque" (remitente opcional + plantilla de
  ataque existente), serializado al formato `script` de `POST /api/campaigns/:id/chat-scripts`.
- **Árbol de respuestas**: elegir una plantilla de origen, ver/agregar/borrar sus ramas
  (clave interna, texto del botón, plantilla destino) contra
  `GET/POST /api/templates/:id/branches` y `DELETE /api/branches/:id`.
- **Credenciales de práctica**: una fila editable por enlace ya generado (usuario/contraseña de
  práctica) que se guarda de una vez contra `POST /api/campaigns/:id/practice-credentials`.

Los "botones de asignación" que el usuario echaba en falta (punto 4 del reporte) son, en la
práctica, esto: no existía ninguna forma de asignar un compañero responsable a una tarea de
plantilla, ni un guion de chat a la campaña, ni credenciales de práctica a un participante, porque
no había dónde hacerlo. Con esta sección ya existen los tres.

Se agregaron ~15 líneas de CSS (`.int-col`, `.int-task`) para que las filas repetibles del
constructor de tableros/guiones se vean agrupadas y espaciadas de forma consistente con el resto del
panel, en vez de reusar clases genéricas que no estaban pensadas para listas dinámicas.

### Verificación

Contra la base de datos de prueba local, con la app completa levantada en memoria (mismo mecanismo
que usan los tests de integración), se ejecutó la secuencia exacta de llamadas que dispara la nueva
UI: crear un compañero ficticio, crear una plantilla de tablero con una tarea asignada a ese
compañero, crear un guion de chat con un paso `scripted` y un paso `attack` apuntando a una plantilla
real, crear una rama del árbol de respuestas entre dos plantillas, y asignar credenciales de
práctica a un enlace ya generado — las cinco operaciones devolvieron `200`/`201` con la forma de
respuesta esperada. Se corrió además la suite completa (`npm test`): 113/113 sin cambios.

## 6. Archivos modificados

- `apps/api/src/lib/decoy.js` — quita el `x-show` que ocultaba el botón "Nuevo tablero"; agrega el
  acceso rápido al chat en la pantalla de inicio.
- `apps/api/public/admin.html` — nuevo paso "6 · Interacción" con sus cinco paneles.
- `apps/api/public/admin.js` — lógica de carga/guardado de las cinco entidades del paso 6.
- `apps/api/public/styles.css` — estilos para las filas repetibles del constructor de
  tableros/guiones.

## 7. Qué queda pendiente

- Decidir, si se quiere avanzar, cuál vector de `docs/2026-09-09_diversificacion-vectores-ataque.md`
  construir primero (ver sección 4) — es una decisión de alcance, no algo que convenga adivinar.
- El panel admin no tiene borrado para plantillas de tablero ni para guiones de chat (el backend
  actual tampoco expone esos endpoints — solo alta y listado). Si hace falta corregir una plantilla
  ya guardada, hoy la única vía es crear una nueva; agregar edición/borrado es una mejora aparte, no
  incluida en esta entrega para no ampliar más el alcance de un reporte que ya tocaba cuatro temas
  distintos.
- El módulo de interacción sigue sin pruebas automatizadas de integración (igual que el resto de
  `admin.js`/`decoy.js`, que son vanilla JS de frontend sin arnés de pruebas en este proyecto); la
  verificación de esta entrega fue manual pero contra la app real y la base de datos real de
  pruebas, no simulada.
