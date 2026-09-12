# Auditoría de preparación para un laboratorio real: fuga de datos cerrada, base de producción limpiada, manual de operación

**Fecha:** 11 de septiembre de 2026
**Disparador:** el usuario pidió, explícitamente, tres cosas para poder ejecutar el sistema "en un laboratorio real": (1) una auditoría técnica con arreglos, (2) limpiar los datos de prueba de producción, y (3) un manual paso a paso para operarlo sin ayuda.

Este documento resume lo que se encontró y lo que se hizo. El manual operativo en sí se entregó como página publicada (ver enlace en la conversación), no como archivo de este repo, para que quede accesible sin depender de un clon del código.

## 1. Hallazgo crítico: las 4 vistas de métricas eran de lectura pública

**Severidad: alta. Ya corregido.**

El *security advisor* de Supabase marcaba las 4 vistas agregadas de `db/schema.sql` (`v_metrics_by_role_vector`, `v_fall_reason_breakdown`, `v_falls_by_team`, `v_team_summary`) como `Security Definer View` (nivel `ERROR`). Se verificó que el problema era real, no solo teórico, consultando directamente `information_schema.role_table_grants` contra el proyecto de producción:

- Los roles `anon` y `authenticated` — los mismos que usa la API REST autogenerada de Supabase (PostgREST) con la clave pública `anon` del proyecto, la misma que es seguro pegar en un cliente porque se asume que no da acceso a nada — tenían `GRANT` de `SELECT/INSERT/UPDATE/DELETE/TRUNCATE` sobre las 4 vistas.
- Al no declarar `security_invoker = true` (disponible desde Postgres 15; este proyecto corre Postgres 17), una vista corre con los privilegios de quien la **creó**, no de quien la consulta — así que activar RLS con políticas reales en las tablas de abajo tampoco habría bloqueado el acceso por esta vía.
- La migración 009 (`rls_hardening_no_anon_access`, aplicada el 9 de septiembre) endureció las **tablas** pero nunca tocó estas 4 **vistas** — quedaron expuestas desde que se crearon, en `schema.sql`/`001_taskflow_decoy.sql`.

**Impacto real:** cualquiera con la clave `anon` pública del proyecto (visible en cualquier cliente que la use, o simplemente conocida por estar en el repositorio si alguna vez se documentó) podía leer las tasas de caída por equipo, por rol y por técnica de ataque — exactamente los resultados que un laboratorio con personas reales necesita mantener confidenciales — sin pasar por `ADMIN_API_KEY` ni por la aplicación en absoluto.

**Arreglo:** migración `014_revoca_acceso_publico_vistas_metricas.sql`:
1. `REVOKE ALL` sobre las 4 vistas de `PUBLIC`, `anon` y `authenticated` (con guardas `IF EXISTS` sobre los roles, porque `anon`/`authenticated` no existen en un Postgres local liso — la misma migración corre igual en Supabase y en la base de pruebas del repo).
2. `ALTER VIEW ... SET (security_invoker = true)` en las 4, para que a futuro tampoco dependan de los privilegios de quien las creó.
3. `GRANT SELECT` explícito a `app_service` (el rol que usa la API vía `DATABASE_URL`), aunque ya tenía acceso por otra vía — para que quede auto-documentado.

Verificado:
- `get_advisors` (security) ya no reporta el hallazgo `security_definer_view` tras aplicar la migración.
- `information_schema.role_table_grants` confirma que `anon`/`authenticated` desaparecieron por completo de los permisos de las 4 vistas; solo quedan `app_service`, `postgres` y `service_role` (interno de Supabase, no expuesto a clientes).
- Aplicada en producción (Supabase, proyecto `ihemxqzuolhmkwikhnlg`) y en la base de pruebas local. Suite completa: 115/115 tests, corrida tres veces para confirmar que `security_invoker=true` no rompe las consultas de `dashboard.js`/`export.js` que usan estas vistas.

## 2. Estado de las migraciones en producción

Se confirmó contra Supabase (no contra el repo) que las 14 migraciones existentes ya están aplicadas: desde `initial_schema` hasta `prioridad_checklist_tareas` (migración 013), más la nueva 014 de este documento. Las tablas nuevas de la migración 010 (`fictitious_contacts`, `board_templates`, `chat_script_templates`, `chat_threads`, `chat_messages`, `message_branches`) existen con RLS activado, igual que las columnas `priority`/`checklist` de `board_tasks` (migración 013).

El hallazgo `rls_enabled_no_policy` (nivel `INFO`, 21 tablas) sigue apareciendo — es el comportamiento **esperado e intencional**: RLS activado sin ninguna política es "denegar por defecto" para `anon`/`authenticated`, mientras que la aplicación (rol `app_service`, con `BYPASSRLS`) sigue viendo todo igual. No requiere acción.

Hallazgos de rendimiento (`INFO`, no bloqueantes): 11 llaves foráneas sin índice de cobertura y 3 índices sin uso todavía (tablas de captura conductual, apenas usadas). No se tocaron — no afectan la viabilidad de una sesión real, solo el rendimiento en volúmenes mucho mayores de los que maneja hoy la base.

## 3. Estado del despliegue (Render)

- El servicio `paws-campaign-api` está activo, sano, y el último despliegue (commit del PR de rediseño de TaskFlow) está `live` sin errores.
- Sin errores nuevos en los logs desde el 10 de septiembre (los últimos que había —`row-level security policy`, `column pc.practice_username does not exist`— son de *antes* de los arreglos ya documentados ese mismo día, no un problema vigente).
- **Plan `free`:** el servicio se suspende solo tras ~15 minutos sin tráfico y tarda de 30 a 50 segundos en reactivarse con la primera visita. No es un defecto del código, es una característica del plan gratuito de Render. Queda anotado como decisión a tomar por el usuario en el manual (subir a un plan de pago si los enlaces se van a abrir en momentos impredecibles a lo largo del día).
- No se pudo leer el valor de `ADMIN_API_KEY` (las herramientas de Render no exponen variables de entorno ya guardadas, solo permiten sobrescribirlas) — queda como verificación manual pendiente del usuario en el manual, en vez de asumida.

## 4. Limpieza de datos de prueba en producción

Se encontraron 3 campañas de desarrollo en la base de producción (`Pruebas 1`, dos veces `Prueba 2`), con 60 participantes de prueba, 125 entregas y 167 eventos asociados — remanentes de rondas anteriores de verificación contra producción. Se confirmó con el usuario antes de borrar nada.

Orden de borrado (respetando las reglas `ON DELETE` de cada tabla — varias son `CASCADE`, pero `participant_campaign → campaigns` es `NO ACTION`, así que hay que borrar en este orden):
1. `participant_campaign` de las 3 campañas (arrastra en cascada: `deliveries`, `events`, `post_session_survey`, `behavior_sessions` y sus `behavior_events`/`behavior_session_features`, `boards` y sus `board_columns`/`board_tasks`, `chat_threads` y sus `chat_messages`).
2. `campaigns` (arrastra: `messages`, `fictitious_contacts`, `board_templates`, `chat_script_templates`, `campaign_templates`).
3. `participants` que quedaron sin ningún `participant_campaign` (los 60 de prueba).

La biblioteca de plantillas de mensajes (`templates`, 21 filas al momento de la limpieza) **no se tocó** — es contenido reusable, no dato de prueba de una campaña.

Verificado: conteo de las 11 tablas relevantes en cero tras la limpieza, salvo `templates` (21, intacta).

## 5. Manual de operación

Se escribió un manual paso a paso ("Manual de lanzamiento PWAS"), construido directamente contra el código de `src/routes/*.js` — **no** contra los README existentes, que están desactualizados (documentan rutas de `tracking.js` que ya no existen, p. ej. `GET /t/:token/message/:mid` en vez de las actuales `GET /t/:token/d/:deliveryId`). Cubre, en el orden real del panel de admin: cargar el roster, crear la campaña, generar enlaces, asignar grupos, sembrar la biblioteca y el módulo de interacción, redactar y enviar el ataque (una técnica por equipo), la verificación previa ya integrada en el panel, distribución de enlaces, monitoreo en vivo, cierre/debriefing y exportación — más una checklist imprimible y una sección de seguridad y ética que documenta el hallazgo de la sección 1.

## 6. Pendientes que quedan fuera de esta ronda

- Aplicar los parches `0018` (botones de un clic del paso 6) y `0019` (guiones de chat por caso) en el repositorio del usuario y desplegarlos — no se puede hacer `git push` desde este entorno.
- Volver a sembrar la biblioteca estándar de plantillas en producción después de ese despliegue (quedó en 21; la versión más reciente trae 31).
- Decisión del usuario sobre el plan de Render (free vs. de pago) antes de una sesión real con enlaces distribuidos de forma asíncrona.
- Confirmación manual de que `ADMIN_API_KEY` en producción no es un valor de prueba.
- Los índices de rendimiento faltantes (sección 2) quedan anotados pero sin acción — no bloquean un laboratorio real a la escala actual.
