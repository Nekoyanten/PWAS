# Asignación aleatoria y balanceada a grupo control/experimental (TG §9.2)

Fecha: 2026-09-06. Este documento explica, para alguien que nunca ha visto
este repositorio, qué se construyó, por qué se construyó así, y cómo se
verificó.

## 1. Qué problema resuelve esto

`participants.group_assignment` (`control`/`experimental`) existe en el
esquema desde el inicio, y ya lo usa la intervención PAWS (jolting, TG
§8.2.5) para decidir a quién mostrarle la capa de intervención — pero hasta
ahora el grupo se fijaba **a mano** al importar participantes (uno por uno o
por CSV, con una columna opcional `group_assignment`). No había ningún
endpoint que lo asignara de forma aleatoria. Esto es un problema real para
el diseño experimental: si el investigador decide el grupo a mano
(aunque sea "al azar" en su cabeza), no hay garantía de que quede
balanceado, y no hay manera de reproducir ese reparto después.

Este feature agrega `POST /api/campaigns/:id/assign-groups`, que reutiliza
`assignBalanced` (`lib/rng.js`) — la misma función que ya reparte el vector
de ataque entre equipos (`GET /:id/plan`) — para repartir el grupo
control/experimental entre los participantes de una campaña, de forma
aleatoria pero balanceada (nunca una diferencia mayor a 1 entre los dos
grupos) y reproducible (misma semilla de campaña + mismo campaignId =
siempre el mismo reparto).

## 2. Decisiones de diseño (y por qué así)

Esto se pensó con cuidado porque toca directamente la validez del diseño
experimental — un error aquí no rompe la app, rompe los datos. Dos
decisiones deliberadamente conservadoras:

- **Por defecto, solo se asignan los participantes con `group_assignment`
  en `NULL`.** Un grupo puesto a mano (import CSV/JSON) nunca se pisa,
  salvo que se pida `{ "force": true }` explícitamente en el body. Esto
  hace que llamar al endpoint sea seguro de repetir: si ya corriste la
  asignación y solo agregaste 3 participantes nuevos, un segundo llamado
  sin `force` asigna solo a esos 3, sin tocar a los demás.
- **Nunca se reasigna a alguien cuya sesión en ESTA campaña ya empezó**
  (`participant_campaign.session_started_at IS NOT NULL`, que se fija la
  primera vez que la persona abre `/app`) — **ni siquiera con
  `force:true`**. Cambiarle el grupo a alguien a mitad o después de la
  prueba invalidaría cualquier dato ya recolectado (p.ej. si ya vio o no la
  intervención jolting, que depende exactamente de este campo). Esta
  protección no es opcional ni tiene bypass: es la única línea roja dura de
  este endpoint. El conteo `omitidos_por_sesion_iniciada` en la respuesta
  le avisa al investigador si esto pasó.

Una consecuencia del esquema existente (no algo nuevo de este cambio):
`group_assignment` vive en la tabla `participants`, no en
`participant_campaign` — es un atributo de la persona, no de su paso por
esta campaña en particular. Si la misma persona (mismo `external_hash`)
participa en dos campañas distintas, asignarle grupo en la campaña A
también se ve reflejado en la campaña B, porque es la misma fila de
`participants`. Esto ya era así desde que existe la columna (el import
manual tiene exactamente el mismo efecto); este endpoint no lo cambia, solo
lo hereda. Para el uso típico del piloto (una persona participa en una sola
campaña) esto no es un problema, pero vale tenerlo presente si alguna vez se
reutiliza el mismo pool de participantes en dos campañas activas a la vez.

## 3. Cómo funciona

`POST /api/campaigns/:id/assign-groups`, body opcional `{ "force": boolean
}` (default `false`), protegido con `x-api-key` como el resto de
`/api/campaigns`.

1. Busca todos los participantes vinculados a esa campaña
   (`participant_campaign` de esa `campaign_id`).
2. Los separa en **bloqueados** (sesión ya empezada — nunca se tocan) y
   **disponibles**.
3. De los disponibles, calcula los **elegibles**: todos si `force:true`, o
   solo los que tienen `group_assignment IS NULL` si no.
4. Llama `assignBalanced(["control", "experimental"], elegibles.length,
   \`${seed}:${campaignId}:group\`)` — la semilla de la campaña (columna
   `campaigns.seed`, la misma que ya se usa para el reparto de vectores)
   combinada con el `campaignId` y un sufijo `:group` para que el reparto de
   grupo no quede correlacionado con el reparto de vector, aunque compartan
   la misma semilla base.
5. Guarda el grupo asignado a cada participante elegible
   (`UPDATE participants SET group_assignment = ...`).
6. Responde con el detalle: `{ asignados, resumen: { control, experimental
   }, omitidos_ya_asignados, omitidos_por_sesion_iniciada }`.

No hace falta ninguna migración de base de datos — la columna y el tipo
`group_assignment` ya existían desde `db/schema.sql`.

## 4. Cómo se verificó

1. Se agregó `tests/unit/rng.test.js` (4 casos, sin Postgres, prueba pura
   de `assignBalanced`): balance real con diferencia máxima de 1 en conteos
   pares e impares (2 a 101), determinismo (misma semilla + count →
   exactamente el mismo arreglo), que semillas distintas dan repartos
   distintos, y el caso borde `count = 0`.
2. Se agregó `tests/integration/group-assignment.test.js` (8 casos, contra
   Postgres real):
   - reparto balanceado (±1) entre los participantes de una campaña real;
   - **reproducibilidad real de extremo a extremo**: dos campañas
     *distintas* con la misma semilla de campaña dan repartos *distintos*
     (confirma que el `campaignId` sí entra en la semilla — si no, dos
     campañas con la misma semilla siempre coincidirían, un bug de diseño
     real que se descartó con esta prueba); y la misma campaña, llamada dos
     veces con `force:true`, da *exactamente* el mismo resultado;
   - que por defecto no pisa un grupo puesto a mano y solo llena los `NULL`;
   - que `force:true` sí reasigna a quien ya tenía grupo, pero nunca a quien
     ya abrió `/app` de verdad (se hizo pasar por el flujo real:
     importar → generar enlace → consentir → completar calibración → abrir
     `/app` — no se simuló con un `UPDATE` directo, para probar el gate tal
     como lo ve un participante real);
   - que no toca participantes de otra campaña;
   - que responder `asignados: 0` sin romper nada si ya no queda nadie por
     asignar;
   - 404 si la campaña no existe, 401 sin `x-api-key`.
3. Al escribir las pruebas se encontró y corrigió un problema real (no en el
   endpoint nuevo, sino en cómo las pruebas usaban uno existente):
   `POST /:id/generate-tokens` sin `participant_ids` vincula a la campaña
   **todo participante del pool global que aún no tenga enlace en ELLA** —
   así está pensado para el caso real de uso (importar una vez, "generar
   enlaces para todos"), pero en una prueba que crea varias campañas
   comparte la misma base, eso arrastra participantes de pruebas anteriores
   hacia la campaña que se está probando, inflando los conteos de forma
   silenciosa. Se corrigió pasando siempre `participant_ids` explícito en
   las pruebas nuevas, según el mismo patrón que ya usaba
   `intervention.test.js`.
4. Suite completa antes de este cambio: **34/34 tests pasan** (línea base).
   Después: **46/46 tests pasan** (34 preexistentes + 4 unitarias + 8 de
   integración nuevas), contra Postgres 16 real.

## 5. Qué falta / límites explícitos de este trabajo

- ~~**No hay botón en el panel admin todavía.**~~ **Resuelto el 6 de
  septiembre** (mismo día, entrega separada): ver
  `docs/2026-09-06_concurrencia-y-botones-asignacion-grupo.md` — ya hay
  botones en la pestaña Campaña y una columna "Grupo" en la tabla de
  enlaces.
- ~~**No hay control de concurrencia (lock).**~~ **Resuelto el 6 de
  septiembre** (mismo día, entrega separada): ver
  `docs/2026-09-06_concurrencia-y-botones-asignacion-grupo.md` — el
  endpoint ahora corre dentro de una transacción con un advisory lock de
  Postgres por campaña, probado de forma determinista (no con dos
  `Promise.all` cruzando los dedos).
- **No estratifica por equipo ni por rol.** El balance es global a nivel de
  campaña (ej. 50/50 en total), no garantiza 50/50 dentro de cada equipo.
  Si el diseño experimental necesita balance por equipo, sería un cambio de
  alcance mayor (asignar por sub-grupos en vez de por campaña completa) que
  no se pidió aquí.

## 6. Aplicar esto

```bash
git apply 0004-asignacion-balanceada-grupo.patch
cd apps/api && npm test   # 46/46 deben pasar
```

No requiere ninguna migración nueva de base de datos.
