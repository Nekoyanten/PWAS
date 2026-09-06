# Concurrencia real en la asignación de grupo + botones en el panel admin

Fecha: 2026-09-06. Complementa directamente a
`docs/2026-09-06_asignacion-balanceada-grupo.md` — léelo primero si no lo has
visto: ahí está el diseño completo de `POST /api/campaigns/:id/assign-groups`.
Ese documento dejó anotadas, a propósito, dos limitaciones explícitas. Esta
entrega resuelve la primera (concurrencia) y agrega la interfaz que faltaba;
la segunda (estratificación por equipo/rol) se dejó fuera **a pedido
explícito**, para no tomar una decisión metodológica de tu tesis en tu
nombre — ver sección 3.

## 1. El problema que resolvía y cómo se resolvió

Cita textual de la limitación anterior: *"Si dos personas llamaran a este
endpoint al mismo tiempo sobre la misma campaña, ambas leerían el mismo
conjunto de 'elegibles' antes de escribir, y el resultado final podría
mezclar los dos repartos."*

La causa era estructural: el endpoint hacía varias consultas sueltas
(`query(...)`) una tras otra, cada una pudiendo ir a una conexión distinta
del pool, sin ninguna sección atómica. Dos llamadas casi simultáneas podían
intercalar sus lecturas y escrituras libremente.

**La solución tiene dos partes:**

1. **`withTransaction(fn)`** — una función nueva en `apps/api/src/db.js`
   que reserva un solo cliente del pool, corre `fn` entre `BEGIN` y
   `COMMIT` (con `ROLLBACK` si algo lanza), y siempre libera el cliente al
   final. Todo el cuerpo de `assign-groups` (leer elegibles, calcular el
   reparto, escribirlo) ahora corre dentro de una sola llamada a
   `withTransaction`, usando `client.query(...)` para cada paso — así todo
   queda en la misma conexión/transacción.
2. **Un advisory lock de Postgres** (`pg_advisory_xact_lock(hashtext(campaignId))`)
   como primera instrucción dentro de esa transacción. Es el mecanismo
   nativo de Postgres para esto: un lock identificado por un número (aquí,
   el hash del id de la campaña) que cualquier otra transacción que pida el
   mismo número tiene que esperar a que se libere. Se libera solo — ese es
   el sentido de "xact" (por transacción) — al hacer `COMMIT` o `ROLLBACK`,
   sin que el código tenga que acordarse de soltarlo ni riesgo de dejarlo
   pegado si algo falla a mitad de camino.

Con esto, si dos llamadas llegan casi al mismo tiempo para la **misma**
campaña, la segunda queda esperando en el lock hasta que la primera termine
por completo — nunca leen el mismo conjunto de "elegibles". Campañas
**distintas** (distinto id → distinto hash) nunca se bloquean entre sí, así
que el caso normal de un solo investigador trabajando no se ve afectado en
nada.

## 2. Cómo se verificó (y un hallazgo importante sobre cómo NO probar esto)

La primera versión de la prueba de concurrencia que escribí disparaba dos
`POST` reales por HTTP al mismo tiempo con `Promise.all()` y esperaba que
uno reportara `asignados: 0`. **Se descartó a propósito** porque, al
quitarle el lock al código a mano y volver a correrla para confirmar que sí
detectaba el problema, la prueba **pasó igual, sin el fix**. La razón: el
tiempo de ida y vuelta por HTTP entre dos `fetch()` casi nunca alcanza a
solaparse justo en la ventana exacta de la carrera — el timing de red por sí
solo ya alcanza a serializarlas la mayoría de las veces. Una prueba que pasa
tanto con el bug como con el arreglo no prueba nada, así que no se puede
confiar en ella para decir "esto ya quedó cubierto". Vale la pena dejarlo
explicado porque es un error fácil de cometer al probar concurrencia.

En su lugar, se escribieron dos pruebas deterministas que no dependen de que
dos llamadas se solapen por azar:

1. **Prueba del mecanismo puro**: dos clientes de Postgres reales, uno
   toma el lock de una campaña y lo retiene a propósito (sin hacer
   `COMMIT`); se confirma que el segundo cliente, pidiendo el mismo lock,
   NO lo consigue dentro de un timeout corto; se libera el primero y se
   confirma que el segundo lo consigue de inmediato.
2. **Prueba de que el ENDPOINT de verdad usa ese mecanismo** (la más
   importante): se toma el lock de una campaña "desde afuera", con un
   cliente crudo, sin pasar por el endpoint. Con ese lock externo tomado,
   se llama a `POST /assign-groups` por HTTP de verdad — y se confirma que
   esa llamada NO responde dentro de un timeout corto, es decir, que
   efectivamente se quedó esperando el lock. Se libera el lock externo y se
   confirma que el endpoint entonces sí responde, con el resultado
   correcto. Esta prueba se corrió primero CON el fix (pasa) y luego se le
   quitó el lock al código a mano para confirmar que SIN el fix, la misma
   prueba falla de verdad (el endpoint responde de inmediato, sin esperar
   nada) — así se confirmó que la prueba realmente detecta el problema que
   dice detectar, no solo que "pasa".
3. Se conservó además una prueba de humo con dos llamadas HTTP concurrentes
   reales, pero re-etiquetada honestamente: no prueba el lock (ver punto
   anterior), prueba que el resultado final —exista o no solape real—
   nunca queda inconsistente (nadie se queda sin grupo, nadie se duplica).

Suite completa: **49/49 tests pasan** (46 preexistentes + 3 nuevos), contra
Postgres real.

## 3. Por qué la estratificación por equipo/rol se dejó fuera

La otra limitación citada era: *"No estratifica por equipo ni por rol. El
balance es global a nivel de campaña... Si el diseño experimental necesita
balance por equipo, sería un cambio de alcance mayor."*

Se preguntó explícitamente y la decisión fue **dejar el balance global como
está por ahora**. La razón para preguntar en vez de simplemente
implementarlo: estratificar por equipo, por rol, o por ambos combinados no
es una mejora técnica neutral — es una decisión del diseño experimental de
la tesis (qué variable de bloqueo usa la aleatorización), y estratificar por
equipo+rol combinados con equipos pequeños puede dejar sub-grupos de 1-2
personas donde "balanceado" pierde sentido estadístico. Mejor resuelto
cuando el diseño experimental esté más definido que adivinado ahora. Esta
limitación sigue anotada en `docs/2026-09-06_asignacion-balanceada-grupo.md`
tal cual estaba.

## 4. La interfaz nueva en el panel admin

Antes de esto, `assign-groups` solo se podía llamar con Postman/curl. Ahora,
en la pestaña **"2 · Campaña y enlaces"**, dentro del detalle de la campaña,
hay una sección nueva **"Grupo control / experimental (TG §9.2)"** con:

- **"Asignar grupos (solo pendientes)"** — llama al endpoint sin `force`
  (el modo seguro de repetir: solo llena los que faltan).
- **"Reasignar todos (fuerza)"** — llama con `force: true`, con un diálogo
  de confirmación primero (mismo patrón que ya usaba "Reiniciar campaña"),
  explicando que nunca toca a quien ya empezó su sesión.
- Un mensaje de resultado (`#groupsMsg`) que muestra cuántos se asignaron,
  el desglose control/experimental, y cuántos se omitieron y por qué.
- La tabla **"Enlaces por participante"** ahora tiene una columna **Grupo**,
  así que el resultado se ve de inmediato fila por fila, sin tener que
  exportar nada.

Verificado con un navegador real (Chromium vía Playwright): se sembró una
campaña con 6 participantes sin grupo, se confirmó que los botones son
visibles, que el primer clic reparte 3/3 y la tabla lo refleja, que un
segundo clic sin forzar reporta `Asignados: 0` (nadie pendiente), y que
"forzar" sí reasigna a los 6 con el diálogo de confirmación.

## 5. Sobre el despliegue

Esta sesión no tiene permiso de push a GitHub — Render despliega desde el
repo, así que el camino sigue siendo: aplicas el parche, subes a `main`, y
desde acá disparo el deploy en Render (ya pasó antes que el auto-deploy no
se disparara solo, así que lo confirmo activamente en vez de asumir).

## 6. Aplicar esto

```bash
git apply 0005-concurrencia-y-botones-asignacion-grupo.patch
cd apps/api && npm test   # 49/49 deben pasar
```

No requiere ninguna migración de base de datos.
