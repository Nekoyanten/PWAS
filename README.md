# PAWS Campaign Platform

Plataforma para ejecutar la **simulación de ingeniería social** del trabajo de
grado (Objetivos 1-4): app señuelo, inyección de estímulos de ataque por
vector de influencia, captura de comportamiento seudonimizado y dashboard de
susceptibilidad **agregado — nunca por persona**.

```
apps/api/      API Express + app señuelo "TaskFlow" + panel admin + dashboard
db/            schema.sql, migraciones y exports SQL para las gráficas
loadtest/      script k6 de prueba de estrés
docker-compose.yml
SETUP_LOCAL.md configuración concreta en este equipo (Windows)
```

## Arranque rápido

```bash
cd apps/api
npm install
cp .env.example .env      # editar DATABASE_URL y ADMIN_API_KEY
npm run db:init
npm run seed:demo         # datos de demostración (opcional)
npm start
```

- Administración: <http://localhost:3000/admin.html>
- Dashboard de resultados: <http://localhost:3000/index.html>

Detalle del flujo, endpoints y garantías de privacidad en
[`apps/api/README.md`](apps/api/README.md).

## Privacidad (no negociable)

No se almacena nombre, correo, documento ni IP. El "permiso" que pide la
página señuelo durante el ataque simulado (estilo OAuth: "perfil", "tareas",
"agenda"...) es **simulado** y no accede a ningún recurso real del
dispositivo — no hay cámara, micrófono ni ubicación detrás de esa pantalla.
El contenido de los formularios se **descarta** antes de tocar la base de
datos. A los participantes se les informa de una "prueba de usabilidad"; la
simulación de ataque se revela en el **debriefing** al final.

Aparte de eso, y como extensión explícita fuera del alcance original,
el sistema sí puede activar la cámara real del participante para medir 5
señales faciales agregadas (parpadeo, apertura ocular, mirada, tensión
facial) — solo cuando el participante marcó por separado un consentimiento
de cámara dedicado (`camera_consent_given`), nunca asumido del consentimiento
general. El procesamiento es 100% local en el navegador: nunca se guarda ni
se envía video, imágenes ni landmarks faciales. Ver
[`docs/2026-09-12_captura-facial-biometrica.md`](docs/2026-09-12_captura-facial-biometrica.md)
y la nota de cumplimiento en [`db/schema.sql`](db/schema.sql).
