# Fix en producción: RLS bloqueaba a `app_service` y un error de base tumbaba todo el proceso

Fecha: 2026-09-10. El usuario reportó en el piloto real desplegado en Render
dos errores al usar el panel admin: `HTTP 400` al importar participantes y
`HTTP 502` al crear una campaña. Pidió diagnosticarlo y corregirlo de raíz.
Ambos errores resultaron ser el mismo problema visto desde dos rutas de
código distintas, más un segundo problema real (y más grave a mediano
plazo) que salió a la luz al investigarlo: una excepción sin capturar en
cualquier endpoint puede tumbar todo el servidor, no solo la petición que
falló.

## 1. Diagnóstico

Con acceso a los logs de Render (`paws-campaign-api`) y a los logs y
`pg_roles`/`pg_tables` del proyecto de Supabase (`ihemxqzuolhmkwikhnlg`) se
pudo confirmar la causa exacta en vez de adivinarla:

- Los logs de Postgres muestran que el backend se conecta como el rol
  **`app_service`**, no como `postgres`.
- `pg_roles` confirma que `app_service` tiene `rolbypassrls = false`.
- Las 12 tablas de `public` (`campaigns`, `participants`, etc.) tienen Row
  Level Security **activado desde la migración 009, sin ninguna policy
  definida**. La migración 009 documentaba explícitamente que esto era
  seguro porque "la app se conecta como el rol `postgres`, que tiene
  BYPASSRLS = true" — eso era cierto el 9 de septiembre, pero en algún
  momento después el `DATABASE_URL` de Render pasó a usar el rol dedicado
  `app_service` en su lugar, y esa migración nunca se actualizó para
  reflejarlo.
- Postgres, con RLS activo y cero policies, deniega todo por defecto a
  cualquier rol que no sea el dueño de la tabla ni tenga BYPASSRLS:
  - un `SELECT` **no lanza error**, simplemente no devuelve ninguna fila
    — por eso el panel admin venía mostrando campañas, participantes y
    plantillas vacíos sin ningún aviso desde que se aplicó la 009 (se
    confirmó comparando el tamaño de las respuestas JSON en los logs de
    Render, p.ej. `GET /api/participants` devolviendo el body exacto de
    `{"participants":[]}`, contra el conteo real en la base:
    **20 participantes, 2 campañas, 21 plantillas seguían ahí, intactos**
    — el problema era de visibilidad, no de pérdida de datos);
  - un `INSERT` **sí lanza un error explícito**
    (`new row violates row-level security policy for table "..."`,
    código Postgres `42501`).
- Ese error explícito es el que producía los dos síntomas reportados, por
  caminos distintos según cómo cada ruta maneja errores:
  - `routes/participants.js` (`/import` e `/import-csv`) captura el error
    **por fila**, dentro de un `try/catch`, y lo reporta como
    `{ imported: 0, failed: N, errors: [...] }` con status `400` cuando
    fallan todas las filas — de ahí el `HTTP 400`.
  - `routes/campaigns.js` (`POST /`) **no** envuelve el `INSERT` en
    `try/catch`. El error se propaga como una promesa rechazada sin
    manejar dentro de un handler `async`, y Express 4 no la intercepta por
    sí solo. Desde Node 15, una promesa rechazada sin manejar **tumba todo
    el proceso** (no solo esa petición) — se ve en los logs de Render el
    stack trace del error seguido literalmente de `Node.js v26.8.2` y el
    reinicio del servicio. Mientras el proceso se reinicia (unos segundos),
    cualquier petición que llegue recibe `HTTP 502` de Render por falta de
    upstream — de ahí el `502` al crear la campaña.

## 2. Fix #1 — `ALTER ROLE app_service BYPASSRLS` (migración 011)

El objetivo original de la migración 009 era bloquear a `anon`/
`authenticated` (los roles que usa la API REST autogenerada de PostgREST,
alcanzables con la anon key pública del proyecto) sin restringir el acceso
de la propia app — la app nunca ha usado esa API REST, solo `pg` con
connection string directa. `app_service` es el rol dedicado de la app
(nunca se expone como anon key pública), así que otorgarle `BYPASSRLS`
reproduce exactamente esa intención original con el rol que realmente está
en uso hoy, en vez de escribir y mantener una policy "permitir todo" por
cada tabla — hoy 12, más las 9 que agregó la migración 010, y las que
vengan.

Se aplicó directamente contra producción (confirmado con
`pg_roles.rolbypassrls = true` después del cambio) y se documentó como
`db/migrations/011_grant_bypassrls_app_service.sql`, con el mismo criterio
que ya se usó para la 009: dejar constancia en el repo de un cambio que se
ejecutó primero a mano contra Supabase, para que no se pierda si algún día
se reconstruye la base desde cero. Se verificó que ningún dato se había
perdido (los conteos de `campaigns`/`participants`/`templates` antes y
después del fix coinciden) — el problema era de visibilidad para
`app_service`, nunca de pérdida de datos.

## 3. Fix #2 — que un error de base de datos ya no tumbe el servidor completo

Arreglar el permiso de `app_service` resuelve el incidente concreto, pero
no la causa de fondo de por qué un solo error de base de datos podía
tirar abajo *todo* el servicio para *todos* los participantes activos en
ese momento: casi ninguna ruta de este proyecto envuelve sus consultas en
`try/catch` (confían en que el handler final `app.use((err, req, res,
next) => ...)` de `app.js` las atrape), pero **Express 4 no reenvía por sí
solo el rechazo de una promesa dentro de un handler `async` a ese
middleware** — hace falta capturarlo a mano en cada ruta, o parchear
Express para que lo haga.

Se agregó la dependencia `express-async-errors` (`apps/api/package.json`)
y se importa como el primer `import` de `apps/api/src/app.js`, antes de
registrar cualquier router. Parchea `Router`/`Route` a nivel de prototipo
para que un error lanzado (o una promesa rechazada) dentro de cualquier
handler `async` se reenvíe automáticamente al middleware de errores, en vez
de escapar como una excepción del proceso. Es un cambio de una sola línea
que protege **todas** las rutas existentes y las que se agreguen después,
sin tener que salir a envolver en `try/catch` cada uno de los endpoints uno
por uno (ni acordarse de hacerlo en los nuevos).

De paso, el middleware de errores de `app.js` ahora distingue el código
`42501` (`insufficient_privilege`, el que produce una policy de RLS
rechazando la operación) y responde con un mensaje que apunta directo a la
migración 011, en vez de un `500` genérico indistinguible de cualquier
otro fallo.

### Por qué no alcanzaba con arreglar solo el permiso de RLS

El permiso resuelve el incidente de esta semana. Sin el fix de
`express-async-errors`, el próximo error de base de datos que no sea RLS
—una restricción `UNIQUE`, un deadlock pasajero, una reconexión de
Supabase, cualquier cosa— volvería a tumbar el proceso completo la próxima
vez que ocurriera en una ruta sin `try/catch`, que es la mayoría. Con el
piloto real corriendo con participantes activos, un servidor que se cae
por completo ante cualquier error transitorio de base de datos es un
riesgo mucho más caro que el síntoma puntual que reportó el usuario.

## 4. Verificación

- Prueba nueva, `apps/api/tests/unit/asyncErrorSafety.test.js`: monta una
  app mínima de Express con una ruta que lanza a propósito dentro de un
  handler `async` sin `try/catch`, y confirma que la petición recibe una
  respuesta `500` controlada (no una conexión cortada ni, en producción, un
  proceso caído) — regresión directa del incidente.
- Suite completa: **113/113 pruebas pasan** (112 anteriores + esta),
  confirmando que ninguna ruta existente cambió de comportamiento al
  agregar `express-async-errors`.
- Contra el proyecto de Supabase de producción, tras aplicar la migración
  011: `pg_roles.rolbypassrls` de `app_service` es `true`; los conteos de
  `campaigns`/`participants`/`templates` no cambiaron (nada se perdió).
  No se probó la creación de una campaña real contra producción para no
  dejar datos de prueba en el piloto — la verificación se hizo a nivel de
  rol/permiso, que es lo que efectivamente decide si el `INSERT` pasa o no.

## 5. Actualización — el parche ya quedó desplegado, y apareció un segundo incidente

El usuario desplegó el parche de este documento (`express-async-errors` +
el middleware de errores más específico) poco después de recibirlo —
confirmado en los logs de Render (`deploy dep-dah3081t0dsc73ec8qa0`, commit
`fix-rls-app-service-y-crash-async`, estado `live`). Con eso ya en
producción, el mismo usuario reportó un tercer error: `HTTP 500` genérico
al abrir un enlace de participante (`GET /t/:token`).

### 5.1. Diagnóstico

Gracias al fix de la sección 3, esta vez el error llegó como una respuesta
`500` controlada en vez de tumbar el proceso — se pudo leer directo en los
logs de Render sin tener que reconstruir nada:

```
error: column pc.practice_username does not exist
```

Esa columna la agrega la migración 010 (`participant_campaign.
practice_username`), la del parche 0012 ("interacción ampliada: tableros,
chat, árbol de respuestas"). El código de esa migración **sí** estaba
desplegado en Render (el commit se ve en la lista de deploys), pero la
migración SQL nunca se había corrido contra la base de Supabase de
producción — exactamente la advertencia que ya llevaba el propio
documento de esa entrega ("sigue pendiente aplicarla en Supabase de
producción"), y el mismo patrón de esta semana: `git push` despliega el
código, pero nunca corre las migraciones por sí solo.

Se aplicó la migración 010 completa directamente contra
`ihemxqzuolhmkwikhnlg` (en dos pasos, respetando la separación de
transacciones que ya traía el archivo: primero los `ALTER TYPE ... ADD
VALUE`, después las tablas nuevas) y se confirmó con
`information_schema.columns` que las columnas y las 9 tablas nuevas
(`boards`, `chat_messages`, `message_branches`, etc.) ya existen. El
enlace de ejemplo que compartió el usuario
(`/t/PP3qjRHC5dXvaePGK35ELrf9`) se volvió a probar (con `WebFetch`, sin
dejar ningún dato de prueba) y ahora sirve la página de consentimiento
normal en vez del error.

### 5.2. Un hueco de seguridad que salió a la luz de paso (migración 012)

Al aplicar la 010 recién ahora, el linter de seguridad de Supabase marcó
sus 9 tablas nuevas como expuestas por la API REST autogenerada
(PostgREST) sin RLS — el mismo problema que la migración 009 ya había
cerrado para las 12 tablas originales, reabierto sin querer porque cuando
se escribió la migración 010, activar RLS todavía no era parte del
checklist de cada tabla nueva. Se cerró de la misma forma
(`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, documentado como
`db/migrations/012_rls_tablas_interaccion_ampliada.sql`) y, como
`app_service` ya tiene `BYPASSRLS` desde la migración 011, esto no le
cambia nada a la app — solo termina de cerrar la puerta a `anon`/
`authenticated`.

## 6. Qué falta / recomendación

- Nada pendiente de aplicar contra Supabase: las migraciones 010, 011 y
  012 ya están todas en producción, verificadas.
- El código de `express-async-errors` (parche de la sección 3) ya está
  desplegado y en vivo en Render.
- **Recomendación de proceso, la más importante de esta entrega**: este es
  el segundo incidente seguido causado por lo mismo — una migración SQL
  que se escribe y se prueba localmente, pero nunca se corre contra
  producción porque `git push` solo despliega código. Vale la pena que el
  checklist de cada entrega incluya explícitamente "¿esta entrega trae una
  migración? ¿ya se corrió contra Supabase de producción?" antes de darla
  por terminada — o, mejor aún, evaluar automatizar la aplicación de
  migraciones como parte del deploy (por ejemplo, un build command en
  Render que corra `psql -f` sobre los archivos nuevos de
  `db/migrations/`) para que este tipo de olvido deje de ser posible.
- Recomendación ya anotada y que sigue vigente: si se vuelve a rotar o
  recrear el rol de conexión de la app (`app_service` u otro), revisar
  explícitamente que tenga `BYPASSRLS`, y que toda tabla nueva sume
  `ENABLE ROW LEVEL SECURITY` en la misma migración que la crea — ambos
  puntos fallaron una vez cada uno esta semana precisamente por no estar
  en ningún checklist.
