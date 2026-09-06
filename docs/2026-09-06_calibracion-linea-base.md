# Calibración de línea base — Paso 2 del protocolo (TG §9.5)

Fecha: 2026-09-06. Este documento explica, para alguien que nunca ha visto
este repositorio, qué se construyó, por qué se construyó así, y cómo se
verificó. Continúa directamente el trabajo de
`docs/2026-09-05_captura-conductual-real.md` (captura conductual real) — si
no lo has leído, léelo primero: este trabajo depende de que ese ya exista.

## 1. Qué problema resuelve esto

El protocolo del piloto (TG §9.5) describe una secuencia de pasos: (1)
bienvenida y consentimiento, (2) **calibración (~30s)**, (3) tarea de
navegación con exposición a mensajes (algunos de ataque), (4) encuesta
post-sesión, (5) debriefing. Antes de esta sesión, el paso 2 no existía: el
flujo iba directo de consentimiento a la tarea de navegación (`/app`).

¿Por qué importa la calibración? La captura conductual (implementada el 5 de
septiembre) registra cómo se mueve el mouse y en qué ritmo teclea CADA
participante — pero un número aislado ("este participante tardó 40ms entre
teclas") no dice nada por sí solo: cada persona tiene una velocidad y un
estilo de mouse distintos de base. Sin una línea base *de esa misma persona,
tomada ANTES de exponerla a ningún ataque*, el análisis de 8.2.3 no puede
distinguir "así se mueve siempre este participante" de "así se movió porque
lo sorprendió/apuró un ataque". La calibración es exactamente esa medición
de referencia: neutra, sin ningún estímulo de phishing, tomada una sola vez
al principio de la sesión.

## 2. Qué NO hace (mismo invariante de privacidad del proyecto)

Igual que la captura conductual, la calibración respeta por diseño la regla
del proyecto de que ninguna pantalla captura contenido escrito por el
participante:

- La tarea de tecleo le pide copiar una frase neutra prefijada (sin ningún
  dato personal ni sensible), pero **el valor de ese campo nunca se lee ni
  se envía a ningún lado** — no hay ningún `<form>` que lo someta ni ningún
  `fetch()` que le haga `.value`. Lo único que se registra es el *ritmo* de
  tecleo, a través del mismo `behavior-capture.js` que ya usa el resto de
  la app, que solo escucha `keydown`/`keyup` a nivel de documento y solo
  guarda `event.code` (la tecla física), nunca el carácter.
- La tarea de mouse es un simple clic sobre un objetivo que cambia de
  posición — no hay texto que escribir ni decisión que tomar.
- Ningún contenido de ataque (ningún vector, ningún mensaje) aparece en esta
  pantalla: es deliberadamente neutra.

## 3. Cómo funciona, de punta a punta

```
Antes:  consentimiento ──────────────────────────────► /app (tarea de navegación)
Ahora:  consentimiento ──► /calibration (~30s, neutra) ──► /app (tarea de navegación)
```

### 3.1. La pantalla: `renderCalibration()` en `apps/api/src/lib/decoy.js`

Dos tareas neutras, una detrás de otra, en una sola pantalla:

1. **Clics en un objetivo** (línea base de dinámica de MOUSE): un círculo
   aparece en una posición aleatoria dentro de un área acotada; cada clic lo
   mueve a una nueva posición aleatoria. Se repite `CALIBRATION_TARGET_CLICKS`
   veces (8 por defecto) y entonces pasa automáticamente a la siguiente
   tarea.
2. **Copiar una frase neutra** (línea base de dinámica de TECLADO): se
   muestra una frase fija ("El veloz murciélago hindú comía feliz cardillo y
   kiwi.") y un campo de texto para copiarla. Como se explicó arriba, el
   contenido tecleado nunca se lee ni se envía — solo importa el ritmo entre
   teclas, que ya captura `behavior-capture.js` de forma pasiva.

Un cronómetro de 30 segundos (idéntico en estructura al de
`renderJoltingInterstitial`, la pantalla de intervención ya existente)
mantiene el botón "Continuar" deshabilitado hasta que se cumple el tiempo,
mostrando la cuenta regresiva. El cronómetro es enteramente del lado del
cliente — no se valida en el servidor — porque, igual que la intervención,
esta es una herramienta de laboratorio con un investigador presente, no un
control de seguridad adversarial; se sigue el mismo nivel de confianza que
ya usa el resto del flujo del participante en este proyecto.

`behaviorCaptureTag(token, "calibration")` activa la captura conductual en
esta pantalla exactamente igual que en las otras 4 — la migración 004 ya es
genérica por `phase`, así que no hizo falta ningún cambio ahí.

### 3.2. Las rutas nuevas: `apps/api/src/routes/tracking.js`

- **`GET /:token/calibration`**: si no hay consentimiento, redirige a la
  bienvenida. Si la calibración ya se completó, salta directo a `/app` (no
  se repite la tarea neutra en cada revisita, mismo criterio que ya usa la
  intervención con `interventionAlreadyShown`). La primera vez que se
  visita, registra `calibration_started_at`.
- **`POST /:token/calibration/complete`**: registra
  `calibration_completed_at` (y, por robustez, `calibration_started_at` si
  por algún motivo no se hubiera registrado antes) y redirige a `/app`.
- **`GET /:token/app`** (existente, modificada): ahora exige
  `calibration_completed_at`. Si falta, redirige a `/calibration` — un
  participante no puede saltarse la calibración escribiendo la URL de
  `/app` directamente.
- **`GET /:token`** (la raíz, existente, modificada): mismo criterio, para
  que reabrir el enlace desde cero también respete el orden del protocolo.
- **`POST /:token/consent`** (existente, modificada): ahora redirige a
  `/calibration` en vez de a `/app` directamente.

### 3.3. Esquema: `db/migrations/005_calibration.sql`

Agrega dos columnas a `participant_campaign` — mismo patrón que ya existía
para `session_started_at`/`finished_at`, no una tabla nueva:

- `calibration_started_at`: cuándo se le mostró la pantalla por primera vez.
- `calibration_completed_at`: cuándo la terminó. **`NULL` bloquea el acceso
  a `/app`** — es la columna que hace cumplir que el paso sea obligatorio.

`db/schema.sql` (la base consolidada para una instalación nueva) se
actualizó para incluir estas dos columnas directamente en la definición de
`participant_campaign`, seguido de la lección aprendida el 5 de septiembre:
`db/schema.sql` debe llevar ya integrado todo lo que agregan las
migraciones, para que una base nueva no necesite adivinar cuáles migraciones
además de `schema.sql` hacen falta.

### 3.4. Reinicio de un participante: `apps/api/src/routes/campaigns.js`

Los dos endpoints de reset (`POST /api/campaigns/:id/reset` y
`POST /api/campaigns/:id/participants/:pcId/reset`) ahora también limpian
`calibration_started_at`/`calibration_completed_at`, igual que ya limpiaban
`session_started_at`/`finished_at`. Sin este cambio, un participante que
repite la prueba después de un reset habría podido saltarse la calibración
la segunda vez.

## 4. Cómo se verificó

1. Se cargó `db/schema.sql` + las 5 migraciones (`001`-`005`) en la base de
   pruebas local de Postgres, en orden.
2. Se corrió la suite completa existente contra esa base — el nuevo gate
   obligatorio de `/app` rompió 4 archivos de tests que antes iban directo
   de consentimiento a `/app` (`admin.test.js`, `behavior-capture.test.js`,
   `intervention.test.js`, `tracking.test.js`). Se actualizaron los cuatro
   para completar la calibración entre el consentimiento y `/app` (un
   `completeCalibration(token)` — un `POST` a `/calibration/complete` — allí
   donde antes se iba directo), y se agregaron aserciones nuevas donde tenía
   sentido (p.ej. que ir a `/app` sin calibrar redirige de vuelta, y que el
   reset también borra la calibración).
3. Se escribió `tests/integration/calibration.test.js` (8 casos): el gate en
   `/calibration` antes de consentir, que consentir entra a `/calibration` y
   no a `/app`, que `/app` redirige de vuelta si falta calibrar, que
   `calibration_started_at` se registra una sola vez, que la pantalla es
   neutra (sin contenido de ataque), que completar la calibración habilita
   `/app`, que revisitarla después no la repite, y que el reset la borra.
4. Se corrió la suite completa una vez más: **32/32 tests pasan** (24
   preexistentes, todos ajustados y verdes, + 8 nuevos).
5. Se verificó con un navegador real (Chromium vía Playwright, ya
   preinstalado en este entorno) que la interacción del lado del cliente
   funciona de verdad y no solo por inspección del HTML: el objetivo se
   mueve y responde a los 8 clics, la pantalla cambia a la tarea de tecleo
   automáticamente, el campo de texto acepta la frase (y se confirmó por
   diseño de código que ese valor nunca se lee en ningún `fetch`/`form`), el
   botón "Continuar" permanece deshabilitado con la cuenta regresiva
   corriendo, y no se registró ningún error de consola/página.

## 5. Qué falta (límite explícito de este trabajo)

- La duración exacta de cada sub-tarea (8 clics, frase fija) es una elección
  razonable pero arbitraria; si el comité de ética o el diseño experimental
  piden una calibración más larga/corta o una tarea distinta, son
  constantes en la cabecera de `renderCalibration()`
  (`CALIBRATION_TARGET_CLICKS`, `CALIBRATION_PHRASE`) y el `TOTAL_MS` del
  script del cliente — no hace falta rediseñar nada más.
- No se agregó ninguna vista de análisis que use específicamente los datos
  de `phase = 'calibration'` para "normalizar" las métricas de la tarea de
  navegación contra la línea base (p.ej. "velocidad de mouse durante el
  ataque, relativa a su propia calibración"). Esa normalización es
  exactamente el tipo de cálculo que corresponde al pipeline de
  preprocesamiento/features (módulos 2-3, Python, fuera de este repo) — acá
  solo se garantiza que el dato de línea base exista y esté etiquetado.

## 6. Aplicar esto

```bash
git apply paws_calibracion_linea_base.patch
psql "$DATABASE_URL" -f db/migrations/005_calibration.sql   # ya aplicada en Supabase producción, ver Notion
cd apps/api && npm test                                      # 32/32 deben pasar
```
