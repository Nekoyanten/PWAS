# CI de pruebas en GitHub Actions

**Fecha:** 12 de septiembre de 2026
**Disparador:** hallazgo 4.2 del informe de revisión crítica de la tesis (v2, §8.2 + Cap. IX) — "Sin CI de pruebas: no hay integración continua que corra la suite de pruebas en cada push o pull request — `.github/workflows/deploy-render.yml` solo dispara el deploy a Render. Hoy es posible fusionar un cambio que rompe pruebas y que se despliegue a producción automáticamente sin que nada lo impida."

## 1. Qué se agregó

`.github/workflows/ci.yml`, nuevo y separado de `deploy-render.yml` (que sigue intacto y sigue disparando el deploy hook igual que antes). Corre en cada push a `main`, en cada pull request contra `main`, y también manualmente (`workflow_dispatch`).

El job:

1. Levanta un Postgres 16 real como *service container* de GitHub Actions (no un mock) con healthcheck `pg_isready`, para no repetir el mismo error de "Node se conecta antes de que Postgres esté listo" que ya se documentó para el Postgres local de desarrollo.
2. Instala dependencias con `npm ci` (no `npm install`, para que CI use exactamente lo que dice `package-lock.json`).
3. Crea el rol `app_service` con `CREATE ROLE app_service LOGIN;` — ver la sección 2.
4. Aplica `db/schema.sql` y **las 15 migraciones de `db/migrations/` en orden numérico**, con `psql -v ON_ERROR_STOP=1` para que cualquier error de SQL tumbe el job en vez de seguir en silencio.
5. Corre `npm test` (la misma suite de 126 pruebas unitarias + integración que corre en local).

## 2. Por qué hace falta crear `app_service` a mano

La migración 011 (`ALTER ROLE app_service BYPASSRLS;`) asume que ese rol ya existe — en Supabase lo crea quien configuró el proyecto, fuera de las migraciones (ver el comentario de esa misma migración: *"el rol `app_service` tiene que existir de antemano"*). Un Postgres recién creado en el contenedor de CI no lo tiene.

Sin este paso, la migración 011 falla con `role "app_service" does not exist` y el job se detiene ahí — verificado empíricamente antes de escribir el workflow final. Con el rol creado de antemano, las 15 migraciones se aplican limpio, en el mismo orden y sin saltarse ninguna, exactamente como contra producción.

Nota aparte: contra un Postgres local de desarrollo (rol `paws`, superusuario) esto nunca hizo falta, porque un superusuario de Postgres omite RLS sin importar `BYPASSRLS` — por eso la suite local pasaba sin que nadie notara que la migración 011 nunca se había probado desde cero.

## 3. Verificación antes de confiar en el workflow

Antes de dar esto por terminado, se reprodujo el procedimiento completo a mano contra un Postgres local limpio (`paws_ci_test`, sin nada aplicado): `CREATE ROLE app_service LOGIN` → `schema.sql` → las 15 migraciones en orden → `npm test`. Resultado: **126/126 pruebas en verde**, igual que contra la base de desarrollo ya migrada. El workflow reproduce exactamente esos mismos comandos.

## 4. Qué NO cambia

- `deploy-render.yml` no se toca. El deploy a Render sigue disparándose en cada push a `main`, independientemente de si `ci.yml` pasa o falla — GitHub Actions no encadena automáticamente dos workflows distintos por sí solo.
- Esto es intencional por ahora: conectar el resultado de `ci.yml` como *required check* que bloquee el merge (branch protection) es una configuración del repositorio en GitHub, no algo que un workflow pueda forzar desde el propio código. Queda como siguiente paso operativo: en GitHub → Settings → Branches → añadir una regla de protección sobre `main` que exija que el job `test` de `ci.yml` pase antes de poder fusionar.
