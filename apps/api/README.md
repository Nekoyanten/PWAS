# PAWS Campaign — API + Dashboard

Sistema real y probado (no un mockup) para ejecutar la simulación de ingeniería
social del piloto: cargar participantes seudonimizados, generar campañas,
capturar quién abrió/hizo clic/intentó enviar un formulario, y ver los
resultados **agregados por equipo, rol y escenario — nunca por persona**.

Probado en esta misma sesión de principio a fin: `npm test` (6/6 pruebas OK),
servidor real levantado, flujo completo abrir→clic→enviar→encuesta ejecutado
contra una base PostgreSQL real, y verificado que el dashboard nunca expone
el hash del participante.

## 1. Requisitos

- Node.js ≥ 18 (probado con Node 22)
- PostgreSQL ≥ 14 corriendo en algún lado (local, Docker, o el servidor del laboratorio)

## 2. Arrancar en 4 comandos (sin Docker)

```bash
cd apps/api
npm install
cp .env.example .env        # editar DATABASE_URL y ADMIN_API_KEY
npm run db:init              # aplica db/../db/schema.sql
npm start
```

Abrir `http://localhost:3000/index.html`, pegar el valor de `ADMIN_API_KEY`
del `.env` en el campo "Clave de administrador" y pulsar "Cargar datos".

## 3. Ver el dashboard con datos de ejemplo (antes de tener datos reales)

```bash
npm run seed:demo
```

Siembra ~45-55 participantes sintéticos (external_hash de mentira, tipo
`demo_hash_0007`) repartidos en 5 equipos, con eventos y encuestas
realistas. Sirve para mostrarle algo funcionando a tu docente en la primera
entrega, y para probar el dashboard sin exponer a nadie real todavía. Borra
estos datos antes de la ejecución real:

```sql
TRUNCATE participants, templates, campaigns, participant_campaign, events, post_session_survey CASCADE;
```

## 4. Arrancar con Docker (alternativa, útil en el servidor del laboratorio)

```bash
cd ..    # raíz de paws-campaign/
cp apps/api/.env.example .env   # ajustar ADMIN_API_KEY y POSTGRES_PASSWORD
docker compose up --build
```

## 5. Flujo operativo real (Track B del plan anterior)

1. `POST /api/templates` — crear una plantilla por escenario (vector de
   influencia: autoridad/urgencia/escasez/prueba_social/curiosidad).
2. `POST /api/campaigns` — crear la campaña, apuntando a una plantilla.
3. `POST /api/participants/import` — cargar la lista de participantes.
   **El hash se genera FUERA de este sistema** (nunca aquí) a partir del
   identificador real; este backend solo recibe y guarda el hash. Incluir
   `team_label` (ej. `"Equipo 5"`) para que el dashboard pueda agrupar.
4. `POST /api/campaigns/:id/generate-tokens` — genera un enlace de un solo
   uso por participante (`/t/<token>`). Estos son los enlaces que se
   entregan dentro del laboratorio (correo local, mensajería local, o QR
   impreso — el mecanismo de entrega queda fuera de este backend por ahora,
   ver "Siguientes pasos").
5. El participante abre su enlace, interactúa con la página señuelo
   (`src/routes/tracking.js` la genera; personalizarla ahí para cada
   escenario) y, si aplica, la aplicación registra clic e intento de envío
   — **nunca el contenido de lo que haya escrito**.
6. Al terminar, se le pide llenar `POST /t/<token>/survey` (motivo de
   caída, autoinformado) durante el debriefing.
7. Dashboard (`/index.html`) o `GET /api/dashboard/overview` para ver todo
   agregado. `GET /api/export/by-team.csv` para el CSV que pediste
   ("Equipo 5: 3 cayeron por tal motivo").

## 6. Endpoints

Administración (requieren cabecera `x-api-key: <ADMIN_API_KEY>`):

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/templates` | Crear plantilla de ataque |
| GET | `/api/templates` | Listar plantillas |
| POST | `/api/campaigns` | Crear campaña |
| GET | `/api/campaigns` | Listar campañas |
| POST | `/api/campaigns/:id/generate-tokens` | Generar enlaces de un solo uso |
| PATCH | `/api/campaigns/:id/status` | Cambiar estado de la campaña |
| POST | `/api/participants/import` | Importar participantes (hash+rol+equipo) |
| GET | `/api/participants` | Listar participantes (hash seudónimo, no identidad) |
| GET | `/api/dashboard/overview` | Todo el resumen de un vistazo |
| GET | `/api/dashboard/by-team` | Detalle por equipo |
| GET | `/api/dashboard/by-role-vector` | CTR/conversión por rol y escenario |
| GET | `/api/export/by-team.csv` \| `.json` | Export para las gráficas de la tesis |
| GET | `/api/export/by-role-vector.csv` \| `.json` | Ídem, por rol/escenario |

Participante (públicas, sin `x-api-key`, solo requieren el token del enlace):

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/t/:token` | Registra "abierto", muestra la página señuelo |
| GET | `/t/:token/click` | Registra "clic", muestra el formulario señuelo |
| POST | `/t/:token/submit` | Registra "intento de envío" (nunca el contenido) |
| POST | `/t/:token/report` | Registra que el participante reportó el mensaje como sospechoso |
| POST | `/t/:token/survey` | Encuesta post-sesión / debriefing |

## 7. Cómo correr las pruebas

```bash
DATABASE_URL=postgres://paws:paws_local_dev@localhost:5432/paws_campaign \
ADMIN_API_KEY=test_key_local_only \
npm test
```

Usa una base real (no mocks): crea plantilla→campaña→participante→token,
recorre el flujo completo, y verifica explícitamente por código que:
- `fell_for_attack` se calcula desde los eventos reales, no desde lo que
  diga el participante.
- El dashboard agregado nunca contiene el `external_hash` en su respuesta.
- Si alguien manda credenciales en el body de `/submit` (por error de una
  futura modificación), igual no se guardan.

**Importante:** corre las pruebas contra una base de **desarrollo/staging**,
nunca contra la base del piloto real — insertan datos de prueba.

## 8. Qué falta / siguientes pasos (para "ir mejorándolo")

Esto es un MVP real y funcional, no un prototipo de mentira, pero quedó
deliberadamente simple para llegar rápido a la primera entrega. Lo próximo,
en orden de impacto:

1. **Entrega real de los estímulos dentro del laboratorio** (correo local
   vía Mailpit/MailHog, o página de "bandeja de entrada" simulada) — hoy
   los enlaces `/t/:token` existen pero hay que decidir cómo llegan al
   dispositivo del participante dentro de la LAN (Track B del plan
   anterior ya lo especifica).
2. **Autenticación real de administrador** — hoy es una sola clave
   compartida (`ADMIN_API_KEY`), suficiente para un piloto de laboratorio
   con un solo operador, pero no para múltiples investigadores.
3. **Dashboard en vivo por WebSocket** (Redis + Socket.IO, como se diseñó
   en el plan anterior) en vez de botón "Cargar datos" — útil si quieres
   ver los números moverse durante la sesión, no imprescindible para la
   primera entrega.
4. **Importación de participantes por CSV** desde el dashboard (hoy es un
   POST JSON — funciona, pero cargar un archivo es más cómodo que armar
   el JSON a mano).
5. **Pruebas de estrés** — el script `loadtest/k6_script.js` del mensaje
   anterior ya existe; falta generar `synthetic_tokens.json` (una campaña
   de prueba con 200 participantes sintéticos) antes de poder correrlo.
