# Puesta en marcha local (Windows)

Notas de la configuración hecha en este equipo. El `.env` real **no** se sube
al repo (está en `.gitignore`); aquí queda documentado cómo recrearlo.

## Lo que se instaló

- **Node.js 24** (ya estaba)
- **PostgreSQL 16** vía `winget install PostgreSQL.PostgreSQL.16`
  - Este equipo ya tenía PostgreSQL 17 y 18 en los puertos 5432 y 5433, así
    que la instalación 16 quedó en el **puerto 5434**.
  - Superusuario `postgres` / contraseña `postgres` (por defecto del instalador).
- **GitHub CLI** vía `winget install GitHub.cli`

## Base de datos

```sql
-- como superusuario postgres, en el puerto 5434
CREATE ROLE paws LOGIN PASSWORD 'paws_local_dev';
CREATE DATABASE paws_campaign OWNER paws;
```

Esquema aplicado con:

```bash
"C:\Program Files\PostgreSQL\16\bin\psql.exe" -h 127.0.0.1 -p 5434 -U postgres -d paws_campaign -f db/schema.sql
```

(la extensión `pgcrypto` la crea `postgres`; luego se hace
`GRANT ALL ... TO paws` sobre tablas y secuencias).

## `apps/api/.env` (recrear si falta)

```
DATABASE_URL=postgres://paws:paws_local_dev@127.0.0.1:5434/paws_campaign
PORT=3000
ADMIN_API_KEY=<clave-generada-localmente>
```

## Arrancar

```bash
cd apps/api
npm install
npm run seed:demo      # datos sintéticos de demostración
npm start
```

- **Administración** (crear plantillas, campañas, importar participantes,
  generar enlaces): <http://localhost:3000/admin.html>
- **Dashboard** de resultados: <http://localhost:3000/index.html>

En ambas páginas, pega el `ADMIN_API_KEY` del `.env` en "Clave de administrador".

## App señuelo "TaskFlow" (vista del participante)

Los enlaces `/t/<token>` que genera el panel de admin son la simulación:
consentimiento → tablero TaskFlow + bandeja → mensaje-estímulo → aterrizaje
(formulario o permiso simulado) → "Finalizar piloto" → encuesta adaptada al
vector → debriefing. Ábrelos en ventana de incógnito para probarlos como un
participante.

## Pruebas

```bash
cd apps/api
npm test               # 6/6 (lee DATABASE_URL y ADMIN_API_KEY del .env)
```

> Las pruebas insertan datos: correrlas contra esta base local de desarrollo,
> nunca contra la del piloto real.
