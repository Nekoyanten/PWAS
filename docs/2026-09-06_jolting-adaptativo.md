# Intervención (jolting) adaptativa: probabilidad configurable, no siempre/nunca (TG §8.2.5 / §9.2)

Fecha: 2026-09-06. Este documento explica, para alguien que nunca ha visto
este repositorio, qué se construyó, por qué se construyó así, y cómo se
verificó.

## 1. Cómo funcionaba antes (y por qué era un problema real)

El aviso "Espera un momento antes de continuar" (el interstitial de
"jolting", `renderJoltingInterstitial` en `lib/decoy.js`) se activa en
`GET /t/:token/d/:deliveryId/go`, cuando el participante hace clic en el
enlace de un mensaje de ataque. Antes de este cambio, la decisión era una
sola pregunta, sin ningún elemento de azar:

```js
function isExperimental(pc) {
  return pc.group_assignment === "experimental";
}
// ...
if (isExperimental(pc) && !(await interventionAlreadyShown(d.delivery_id))) {
  // muestra el aviso
}
```

Grupo **experimental** → el aviso sale **siempre**, en el 100% de los
ataques. Grupo **control** → **nunca** sale. Cero variación dentro del grupo
experimental.

Esto es un problema de validez del diseño experimental, no un bug de código:
si a todo el mundo en el grupo experimental se le avisa explícitamente
"esto puede ser un ataque, ¿estás seguro?" antes de cada clic, lo que el
sistema termina midiendo no es "¿la persona reconoce y cae en un engaño de
phishing en condiciones realistas?" sino "¿la persona ignora una advertencia
explícita que ya le dieron?" — dos preguntas de investigación distintas. Con
un patrón binario (100% / 0%) es imposible separar ambas cosas en el
análisis posterior, que es exactamente la limitación que motivó este cambio.

## 2. Qué se construyó

Tres piezas nuevas, todas en la migración `006_jolting_adaptativo.sql`:

1. **`messages.jolting_enabled`** (booleano, `DEFAULT TRUE`): interruptor
   por mensaje de ataque. Si es `FALSE`, ese mensaje **nunca** muestra el
   aviso, a nadie, sin importar el grupo — cubre el caso "necesito poder
   enviar el ataque sin que salga ningún mensaje de advertencia".
2. **`campaigns.jolting_probability`** (numérico 0..1, `DEFAULT 1.000`):
   probabilidad de que un **envío concreto** de un mensaje con
   `jolting_enabled = TRUE` efectivamente muestre el aviso al grupo
   experimental. En vez de "siempre" (`1.0`) o "nunca" (`0.0`), el
   investigador puede fijar, por ejemplo, `0.4` para que el aviso salga en
   ~40% de los envíos — variabilidad real y medible, en vez de un patrón
   fijo.
3. **`deliveries.jolting_roll`** (booleano, `DEFAULT TRUE`): el resultado
   de ese sorteo, calculado **una sola vez**, en el momento de crear el
   delivery (`POST /messages/:id/send`), y guardado — no se vuelve a
   calcular en cada clic del participante.

La condición de activación pasó de "¿es experimental?" a "¿es experimental
**Y** el mensaje lo permite **Y** el sorteo de este envío salió positivo?"
(`joltingEligible()` en `tracking.js`):

```js
function joltingEligible(pc, d) {
  return isExperimental(pc) && d.jolting_enabled === true && d.jolting_roll === true;
}
```

El grupo control sigue sin verlo nunca, bajo cualquier configuración — eso
no cambió.

## 3. Por qué el sorteo se fija al ENVIAR y no en cada clic

Si el sorteo se recalculara cada vez que el participante abre el enlace
(`GET /go`), reabrir el mismo mensaje podría "cambiar de opinión" sobre si
mostrar el aviso o no — un bug de diseño serio: el mismo estímulo, para la
misma persona, daría resultados distintos según cuántas veces recargó la
página, y el dato dejaría de ser reproducible o auditable.

En su lugar, el sorteo se calcula **una vez**, en `POST /messages/:id/send`
(`messages.js`), con el mismo patrón de PRNG sembrado y determinista que ya
usa `assignBalanced` para repartir vectores y grupos (`lib/rng.js`:
`hash32` + `mulberry32`):

```js
function rollJolting(campaignSeed, messageId, participantCampaignId, probability) {
  const rand = mulberry32(hash32(`${campaignSeed}:${messageId}:${participantCampaignId}:jolting`));
  return rand() < Number(probability);
}
```

La semilla combina `campaigns.seed` (la misma columna que ya se usa para el
reparto de vectores y de grupo control/experimental) + el `message_id` + el
`participant_campaign_id` del destinatario. Esto da tres garantías:

- **Reproducible**: la misma campaña, el mismo mensaje y el mismo
  participante siempre producen el mismo resultado — se puede reconstruir y
  auditar después.
- **Independiente por delivery**: el `participant_campaign_id` entra en la
  semilla, así que dos participantes distintos del mismo envío no quedan
  correlacionados (se verificó explícitamente que NO caen todos del mismo
  lado del sorteo — ver pruebas).
- **Fijo en el tiempo**: cambiar `jolting_probability` de la campaña
  *después* de un envío no altera los `deliveries.jolting_roll` ya
  guardados ni lo que ve un participante que ya recibió ese mensaje. Solo
  afecta a los mensajes que se envíen después del cambio.

## 4. Compatibilidad hacia atrás (deliberada)

Toda campaña y mensaje que ya existían antes de esta migración quedan
funcionando exactamente igual que antes, sin que el investigador tenga que
hacer nada:

- `campaigns.jolting_probability` nace en `1.000` para toda campaña
  existente.
- `messages.jolting_enabled` nace en `TRUE` para todo mensaje existente.
- `deliveries.jolting_roll` nace en `TRUE` para todo delivery ya creado
  (coherente: con probabilidad 1.0 el sorteo siempre habría dado `TRUE`).

Es responsabilidad explícita del investigador bajar la probabilidad para
las campañas donde quiera medir esto de forma adaptativa — el cambio no
altera silenciosamente ninguna campaña ya en curso o ya corrida.

## 5. Superficie nueva (API y panel admin)

- `PATCH /api/campaigns/:id/jolting` — body `{ "probability": 0..1 }`,
  protegido con `x-api-key`. Valida el rango, 404 si la campaña no existe.
- `POST /api/campaigns/:id/messages` y `POST /api/campaigns/:id/messages`
  (mensaje libre o desde plantilla) aceptan `jolting_enabled: boolean`
  (default `true` si no se manda).
- `POST /api/messages/:id/clone` conserva el `jolting_enabled` del mensaje
  original.
- **Panel admin** (pestaña "2 · Campaña"): nueva sección "Aviso 'Espera un
  momento…' (intervención adaptativa)" con un campo numérico (0–1) y botón
  "Guardar probabilidad".
- **Panel admin** (pestaña "4 · Mensajes"): nuevo checkbox "Puede mostrar
  el aviso…" al redactar un mensaje de ataque (marcado por defecto), y una
  columna "Aviso" en la tabla de mensajes guardados que muestra "puede
  salir" o "nunca".

## 6. Cómo se verificó

Suite completa antes de este cambio: **49/49 tests pasan** (línea base,
Postgres 16 real). Se agregó `tests/integration/jolting-adaptativo.test.js`
(10 casos nuevos, contra Postgres real, sin mocks) que cubre:

- **compatibilidad hacia atrás**: con la configuración por defecto
  (`probability=1.0`, `jolting_enabled=true`), el experimental ve el aviso
  en el 100% de los envíos y el control en el 0% — idéntico al
  comportamiento anterior a esta migración;
- **`jolting_enabled=false` gana siempre**: aunque la probabilidad de la
  campaña sea `1.0` y el grupo sea experimental, un mensaje "silencioso"
  nunca muestra el aviso;
- **`probability=0.0`**: nunca sale, aunque el mensaje lo permita y el
  grupo sea experimental;
- **probabilidad intermedia (0.4, sobre 60 envíos)**: prueba estadística
  con tolerancia — confirma que la tasa observada ni es 0% ni 100% (el
  síntoma exacto del diseño anterior) y que se acerca al valor configurado;
- **el roll queda fijo al enviar**: bajar la probabilidad de la campaña
  después de un envío no cambia lo que ven los deliveries ya creados;
- **determinismo real**: con 10 participantes y `p=0.5` en el mismo envío,
  los resultados no caen todos del mismo lado (confirma que el
  `participant_campaign_id` sí entra en la semilla — si no, sería
  estadísticamente extremo, p < 0.002, que los 10 coincidieran);
- clonar un mensaje conserva su `jolting_enabled`;
- validación de rango (0..1) y autenticación de `PATCH .../jolting`.

**Verificación de que las pruebas realmente prueban el cambio** (no solo
que "pasan"): se revirtió temporalmente la condición de `tracking.js` a la
lógica determinista anterior (`isExperimental(pc)` en vez de
`joltingEligible(pc, d)`) y se confirmó que **3 de los 10 tests nuevos
fallan** exactamente como se esperaba (el de "silencioso nunca sale", el de
"probabilidad 0.0 nunca sale", y el de "probabilidad intermedia varía");
luego se restauró el fix y se confirmó que los 10 vuelven a pasar. Esto
descarta que las pruebas estuvieran pasando "por accidente" sin ejercer de
verdad la lógica nueva.

**Verificación del panel admin con navegador real** (Playwright +
Chromium, no solo inspección de código): se conectó al panel, se creó una
campaña real, se confirmó que el campo de probabilidad carga `1.000` por
defecto, que guardarlo en `0.35` persiste (recargar la campaña vuelve a
mostrar `0.350`), que el checkbox de aviso está oculto para mensajes de
relleno y aparece marcado por defecto al cambiar el tipo a "Ataque", y que
guardar un mensaje con el checkbox desmarcado lo refleja correctamente como
"nunca" en la tabla de mensajes — sin errores de consola ni de página.

Suite completa después de este cambio: **59/59 tests pasan** (49
preexistentes + 10 nuevos), contra Postgres 16 real.

## 7. Qué falta / límites explícitos de este trabajo

- La probabilidad es **por campaña**, no por mensaje ni por vector de
  ataque. Todos los mensajes con `jolting_enabled=true` de una misma
  campaña comparten la misma `jolting_probability`. Si el diseño necesita
  probabilidades distintas por técnica de ataque, sería un cambio de
  alcance mayor (la columna pasaría a `messages` en vez de `campaigns`).
- No hay una vista en el dashboard de resultados que desglose la tasa de
  caída **según si se mostró o no el aviso** en cada delivery — hoy
  `deliveries.jolting_roll` y `events.event_type = 'intervencion_mostrada'`
  ya tienen el dato para hacer ese cruce (es una consulta SQL directa sobre
  tablas existentes), pero construir esa vista/reporte no se pidió en este
  cambio y queda como trabajo futuro natural para el análisis de H1/H3.
- El `CHECK` de rango en `jolting_probability` está a nivel de base de
  datos (0 a 1 inclusive) además de la validación del endpoint — redundante
  a propósito, para que un `UPDATE` directo a la base (fuera de la API) no
  pueda dejar un valor inválido.

## 8. Aplicar esto

```bash
git apply 0007-jolting-adaptativo.patch
psql "$DATABASE_URL" -f db/migrations/006_jolting_adaptativo.sql
cd apps/api && npm test   # 59/59 deben pasar
```
