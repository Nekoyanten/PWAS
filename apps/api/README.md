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

## 4. Flujo operativo (desde `/admin.html`, pasos 1 → 5)

El panel está guiado. En esta prueba **cada equipo recibe una técnica de ataque
distinta** (para poder compararlas).

1. **Participantes** → pegar el CSV `external_hash,role,team_label`. El hash se
   genera **fuera** de este sistema; nunca subas nombres/correos.
2. **Campaña y enlaces** → crear la campaña (solo un nombre) → "Generar enlaces
   para todos" → copiar/descargar los `/t/<token>` y entregarlos. El panel
   **"Verificación previa"** muestra en verde/rojo qué falta antes de la sesión.
3. **Plantillas** → "Crear biblioteca estándar" (15 ataques = 3 por técnica + 6
   de relleno). Puedes editar textos o "Restaurar textos estándar".
4. **Mensajes** → elegir una plantilla → "Guardar el mensaje" → en la tabla,
   **"enviar"** y marcar el equipo. Envía **una técnica por equipo** (avisa si
   repites). Los mensajes de relleno sí pueden ir a todos.
5. **Resultados** → resumen rápido; el detalle está en el **dashboard**
   (`/index.html`), que se actualiza solo.

Al terminar la sesión: "Marcar finalizada" (habilita la encuesta para quien no
pulsó "Finalizar piloto"). Para repetir pruebas: "Reiniciar campaña".

**Sesión con varios PC en red local** (1 admin + N participantes): ver
[`LABORATORIO.md`](../../LABORATORIO.md) en la raíz del repo.

## 5. Recorrido del participante

`/t/<token>` → consentimiento ("piloto de usabilidad") → TaskFlow (tablero +
bandeja) → abre el mensaje-estímulo → pulsa el CTA → aterrizaje (formulario o
diálogo de permiso) → "Finalizar piloto" → **encuesta adaptada al vector** →
**debriefing**.

El tablero **sondea la bandeja cada 5 s**: cuando el admin envía un mensaje
aparece solo (con un aviso emergente), sin que el participante recargue.

La app señuelo usa **Alpine.js** (por CDN, sin build). El sidebar cambia de
vista sin recargar (`?v=`) y el **kanban es editable**: el participante crea,
edita, borra y arrastra tarjetas. Esas tarjetas viven **solo en su navegador**
(`localStorage`, clave `tf_board_<token>`); nunca llegan al servidor y se borran
en el debriefing — coherente con la nota de privacidad de `db/schema.sql`.

## 6. Endpoints

Administración (`x-api-key: <ADMIN_API_KEY>`):

| Método | Ruta | Qué hace |
|---|---|---|
| POST/GET/PUT/DELETE | `/api/templates[/:id]` | CRUD de plantillas |
| POST | `/api/templates/seed-defaults` | Crea la biblioteca estándar (15 ataque + 6 relleno); `{replace:true}` reescribe las estándar |
| POST/GET | `/api/campaigns` | Crear / listar campañas (con `template_ids` = pool) |
| GET/PUT | `/api/campaigns/:id` | Detalle (pool + distribución asignada) / editar |
| POST | `/api/campaigns/:id/generate-tokens` | Genera enlaces y **asigna el vector por semilla** |
| GET | `/api/campaigns/:id/coverage` | Qué técnica de ataque / relleno recibió cada equipo (verificación previa) |
| PATCH | `/api/campaigns/:id/status` | Cambiar estado |
| GET | `/api/campaigns/:id/links` | Enlaces + vector asignado por participante |
| POST | `/api/participants/import` \| `/import-csv` | Importar participantes |
| GET | `/api/participants` | Listar (hash seudónimo, nunca identidad) |
| GET | `/api/dashboard/overview` | Todo el dashboard: `totales`, `embudo`, `por_tecnica`, `por_rol`, `por_equipo`, `motivos_de_caida`, `percepcion` |
| GET | `/api/dashboard/by-team` \| `/by-role-vector` \| `/fall-reasons` | Vistas agregadas sueltas |
| GET | `/api/export/by-team.{csv,json}` \| `/by-role-vector.{csv,json}` | Export para la tesis |

Participante (públicas, solo con el token del enlace):

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/t/:token` | Enruta según consentimiento / estado |
| POST | `/t/:token/consent` | Acepta el consentimiento |
| GET | `/t/:token/app` | App señuelo TaskFlow |
| GET | `/t/:token/inbox.json` | Bandeja en JSON (sondeo en vivo del tablero) |
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
