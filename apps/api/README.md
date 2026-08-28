# PAWS Campaign — API + Dashboard + App señuelo "TaskFlow"

Sistema real y probado (no un mockup) para ejecutar la simulación de ingeniería
social del piloto:

1. **App señuelo "TaskFlow"** — un organizador de tareas genérico y ficticio
   (kanban + bandeja de mensajes) que el participante usa como una *prueba de
   usabilidad*. Marca deliberadamente genérica: **no clona ningún servicio
   real** (PS §3.2).
2. **Estímulo de ataque inyectado** — dentro de la bandeja aparece un mensaje
   diseñado para este estudio (uno de 5 vectores de influencia). Lo **entrega
   el admin** cuando quiere.
3. **Asignación por semilla** — el vector se reparte entre participantes de
   forma **balanceada y reproducible** (Fisher-Yates sembrado), para que no
   haya sesgo de dispositivo/orden y el análisis sea replicable.
4. **Encuesta final adaptada al vector** + **debriefing** (recién ahí se
   revela que hubo una simulación).
5. **Panel de administración** (`/admin.html`) y **dashboard de resultados**
   (`/index.html`), siempre **agregado — nunca por persona**.

## Qué datos se capturan (y cuáles NO)

Se registra **solo comportamiento**, de forma seudonimizada:

| Se guarda | No se guarda |
|---|---|
| Eventos: `entregado`, `abierto`, `clic`, `intento_envio`, `permiso_concedido`, `reportado` + timestamp | El contenido de cualquier formulario (usuario/contraseña) — se descarta antes de tocar la BD |
| Tiempo de reacción (ms) desde la entrega | Cámara, micrófono, ubicación (el diálogo de permiso es **simulado**; solo se guarda "concedió: sí/no" y la etiqueta) |
| Encuesta autoinformada (motivo de caída, sospecha previa, reconocimiento) | Nombre, correo, documento, IP |
| Contador de interacciones benignas con el tablero | El texto de las tarjetas o cualquier cosa que el participante escriba |

Ver la nota de cumplimiento completa al inicio de `db/schema.sql`.

## 1. Requisitos

- Node.js ≥ 18 (probado con Node 22 y 24)
- PostgreSQL ≥ 14

## 2. Arrancar sin Docker

```bash
cd apps/api
npm install
cp .env.example .env          # editar DATABASE_URL y ADMIN_API_KEY
npm run db:init               # aplica db/schema.sql (base nueva)
npm start
```

- Dashboard de resultados: `http://localhost:3000/index.html`
- Panel de administración: `http://localhost:3000/admin.html`

Pega el `ADMIN_API_KEY` del `.env` en el campo "Clave de administrador".

> **Base ya existente** (creada con una versión anterior del esquema):
> `npm run db:migrate` aplica `db/migrations/001_taskflow_decoy.sql`.

## 3. Datos de demostración

```bash
npm run seed:demo
```

Siembra ~45-55 participantes sintéticos (`external_hash` de mentira) para que
el dashboard tenga algo que mostrar. Bórralos antes del piloto real:

```sql
TRUNCATE participants, templates, campaigns, campaign_templates,
         participant_campaign, events, post_session_survey CASCADE;
```

## 4. Flujo operativo (desde `/admin.html`)

1. **Plantillas** → "Crear las 5 plantillas por defecto" (o crea las tuyas:
   remitente, asunto, cuerpo HTML, CTA, y aterrizaje `form` o `permiso`).
2. **Participantes** → importar por CSV (`external_hash,role,team_label,...`)
   o JSON. El hash se genera **fuera** de este sistema.
3. **Campañas** → "Nueva campaña": nombre, semilla (opcional) y las plantillas
   que entran en el sorteo.
4. Abrir la campaña → **"Generar enlaces"** (asigna el vector por semilla) →
   copiar/descargar los `/t/<token>` y entregarlos a los participantes.
5. Cuando empiece la sesión → **"Entregar estímulo a todos"** (aparece en la
   bandeja; el tiempo de reacción se mide desde aquí).
6. Al terminar → marcar la campaña **`finalizada`** (habilita la encuesta para
   quien no pulsó "Finalizar piloto") y revisar el **dashboard** / exportar CSV.

## 5. Recorrido del participante

`/t/<token>` → consentimiento ("piloto de usabilidad") → TaskFlow (tablero +
bandeja) → abre el mensaje-estímulo → pulsa el CTA → aterrizaje (formulario o
diálogo de permiso) → "Finalizar piloto" → **encuesta adaptada al vector** →
**debriefing**.

## 6. Endpoints

Administración (`x-api-key: <ADMIN_API_KEY>`):

| Método | Ruta | Qué hace |
|---|---|---|
| POST/GET/PUT/DELETE | `/api/templates[/:id]` | CRUD de plantillas |
| POST | `/api/templates/seed-defaults` | Crea las 5 plantillas estándar |
| POST/GET | `/api/campaigns` | Crear / listar campañas (con `template_ids` = pool) |
| GET/PUT | `/api/campaigns/:id` | Detalle (pool + distribución asignada) / editar |
| POST | `/api/campaigns/:id/generate-tokens` | Genera enlaces y **asigna el vector por semilla** |
| POST | `/api/campaigns/:id/deliver` | Entrega el estímulo (fija `delivered_at` + evento `entregado`) |
| PATCH | `/api/campaigns/:id/status` | Cambiar estado |
| GET | `/api/campaigns/:id/links` | Enlaces + vector asignado por participante |
| POST | `/api/participants/import` \| `/import-csv` | Importar participantes |
| GET | `/api/participants` | Listar (hash seudónimo, nunca identidad) |
| GET | `/api/dashboard/overview` \| `/by-team` \| `/by-role-vector` \| `/fall-reasons` | Métricas agregadas |
| GET | `/api/export/by-team.{csv,json}` \| `/by-role-vector.{csv,json}` | Export para la tesis |

Participante (públicas, solo con el token del enlace):

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/t/:token` | Enruta según consentimiento / estado |
| POST | `/t/:token/consent` | Acepta el consentimiento |
| GET | `/t/:token/app` | App señuelo TaskFlow |
| GET | `/t/:token/message/:mid` | Ver un mensaje (abrir el estímulo = evento `abierto`) |
| GET | `/t/:token/stimulus` | Pulsar el CTA = evento `clic` + aterrizaje |
| POST | `/t/:token/submit` | `intento_envio` (descarta el body **siempre**) |
| POST | `/t/:token/grant` | `permiso_concedido` (guarda solo la etiqueta) |
| POST | `/t/:token/report` | `reportado` |
| POST | `/t/:token/usability` | Contador de interacción benigna |
| POST | `/t/:token/finish` | Finaliza el piloto → encuesta |
| GET/POST | `/t/:token/survey` | Encuesta adaptada al vector |
| GET | `/t/:token/debrief` | Debriefing (revela la simulación) |

## 7. Pruebas

```bash
npm test    # lee DATABASE_URL y ADMIN_API_KEY del .env
```

Usa una base real (no mocks): reparto determinista por semilla, flujo E2E
consentimiento→estímulo→caída→encuesta→debrief, y verifica que el dashboard
nunca expone el `external_hash` y que `/submit` no persiste el formulario.

> Corre las pruebas contra una base de **desarrollo**, nunca contra la del
> piloto real — insertan datos.

## 8. Siguientes pasos

1. **Entrega real de los enlaces** dentro del laboratorio (correo local vía
   Mailpit, o "bandeja de entrada" simulada) — hoy los `/t/:token` se entregan
   a mano.
2. **Autenticación de administrador** multiusuario (hoy: una sola clave).
3. **Dashboard en vivo** por WebSocket en vez de botón "Cargar datos".
4. **Piloto multi-día** con cadencia de estímulos (hoy: sesión única).
5. **Prueba de estrés** — `loadtest/k6_script.js` existe; falta generar
   `synthetic_tokens.json`.
