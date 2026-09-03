# Guía para la sesión de laboratorio

Cómo montar la prueba con **1 PC de administración** + **20 y pico PC de
participantes** en la misma red local, con entrega del ataque y resultados
**en tiempo real**.

---

## Cómo funciona el "tiempo real"

No hay que configurar nada: ya está hecho con *sondeo* (polling).

- **Cuando envías un ataque** desde el panel, el tablero de cada participante
  consulta al servidor **cada 3 segundos**. En cuanto detecta el mensaje, lo
  muestra solo, con un aviso emergente y el contador de la pestaña. El
  participante **no recarga nada**. (Latencia típica: 1–4 s.)
- **Cuando los participantes responden** (abren, hacen clic, envían el
  formulario, conceden el permiso, reportan), el **dashboard** (`/index.html`)
  se refresca solo **cada 8 segundos** con la marca "actualizar solo" activada.

Todo funciona **sin internet**: Alpine.js y Chart.js están servidos por el
propio servidor (`/vendor/`). Si los PC del laboratorio no tienen internet, la
única diferencia es que la tipografía será la del sistema en vez de "Inter".

---

## 1. Preparar el PC de administración (una vez)

Este PC hace de **servidor**. Los demás solo necesitan un navegador.

1. **Base de datos limpia** para el piloto real (recomendado: una base aparte de
   la de desarrollo, para que las pruebas `npm test` nunca la toquen):

   ```bash
   "C:\Program Files\PostgreSQL\16\bin\psql.exe" -h 127.0.0.1 -p 5434 -U postgres -c "CREATE DATABASE paws_piloto OWNER paws;"
   "C:\Program Files\PostgreSQL\16\bin\psql.exe" -h 127.0.0.1 -p 5434 -U postgres -d paws_piloto -f db/schema.sql
   ```

   Y en `apps/api/.env` apunta a esa base durante el piloto:
   `DATABASE_URL=postgres://paws:paws_local_dev@127.0.0.1:5434/paws_piloto`

   > Si prefieres usar la misma base de siempre: antes de la sesión ejecuta el
   > `TRUNCATE ... CASCADE` del README y **no corras `npm test` hasta terminar**.

2. **Cambia la clave de administración** en `apps/api/.env`:
   `ADMIN_API_KEY=` (algo largo; no la compartas con los participantes).

3. **Arranca el servidor**:

   ```bash
   cd apps/api
   npm start
   ```

   Fíjate en lo que imprime. Verás algo así:

   ```
   Para los participantes, usa esta dirección de red local:
       http://192.168.1.50:3000/t/<token>
   ```

   Apunta esa **IP** (`192.168.1.50` en el ejemplo). Es la de este PC en la red.

4. **Permite el acceso en el cortafuegos de Windows.** La primera vez que
   arranques, Windows preguntará: marca **"Redes privadas"** y "Permitir acceso".
   Si no salió el aviso: Panel de control → Firewall de Windows Defender →
   "Permitir una aplicación" → añade **Node.js** en redes privadas. O, en una
   terminal de administrador:

   ```
   netsh advfirewall firewall add rule name="PAWS 3000" dir=in action=allow protocol=TCP localport=3000
   ```

5. **Comprueba desde OTRO PC** que llega: abre `http://<IP-del-admin>:3000/health`.
   Debe responder `{"ok":true,"db":"up"}`. Si no carga → cortafuegos o los PC no
   están en la misma red/segmento.

---

## 2. Preparar la campaña (antes de que lleguen los participantes)

Abre el panel **usando la IP, no `localhost`**: `http://<IP-del-admin>:3000/admin.html`
(así los enlaces que copie y descargue ya llevan la IP correcta).

Pega la `ADMIN_API_KEY` → **Conectar**. Luego los pasos 1 → 5:

1. **Participantes** — pega el CSV con una fila por persona:

   ```
   external_hash,role,team_label
   p01,estudiante,Sala 1
   p02,estudiante,Sala 1
   ...
   p11,profesor,Sala 2
   ...
   ```

   - `external_hash`: un código cualquiera **sin datos personales** (`p01`,
     `p02`…). Es lo único que identifica a la persona en el sistema.
   - `team_label`: la sala/grupo. **En esta prueba, cada equipo recibe una
     técnica de ataque distinta**, así que agrupa a los participantes según el
     reparto que quieras (p. ej. Sala 1 = autoridad, Sala 2 = urgencia…).

2. **Campaña y enlaces** — crea la campaña (solo un nombre). En "Dirección base
   de los enlaces" pon `http://<IP-del-admin>:3000`. Pulsa **"Generar enlaces
   para todos"**. Descarga el CSV o copia los enlaces.

   Mira la **Verificación previa**: te dirá en rojo lo que falta.

3. **Plantillas** — "Crear biblioteca estándar" (15 ataques + 6 de relleno). Ya
   están redactadas; puedes retocar textos.

4. **Mensajes** — deja preparados los ataques que vas a enviar (uno por técnica):
   elige la plantilla → "Guardar el mensaje". **Todavía no los envíes.**
   Opcional: envía 1–2 mensajes de relleno a toda la campaña para que la bandeja
   no esté vacía al empezar.

---

## 3. Repartir los enlaces a los 20+ PC

Cada participante necesita **su** enlace `http://<IP>:3000/t/<token>`. Opciones:

- **Hoja compartida**: pon el CSV de enlaces en una carpeta de red o un documento
  y que cada persona copie su fila (por su `external_hash`).
- **Uno por uno**: desde la tabla de enlaces del panel, cada fila es clicable.
- **Antes de la sesión**: deja cada PC con su enlace ya abierto en el navegador,
  en pantalla de bienvenida.

> El enlace es personal y de un solo uso por persona. Si alguien lo abre en dos
> pestañas, ambas comparten la misma sesión.

---

## 4. Durante la sesión

1. Cada participante abre su enlace → acepta el consentimiento ("piloto de
   usabilidad") → usa **TaskFlow** con normalidad (mover y **crear** tarjetas,
   revisar la bandeja).
2. En el panel, paso 2: pulsa **"Marcar en curso"**.
3. Abre el **dashboard** (`/index.html`) en otra pestaña o en un segundo monitor,
   con "actualizar solo" activado.
4. Cuando quieras lanzar el ataque: paso 4 → en la tabla de mensajes, **"enviar"**
   en el ataque de esa técnica → marca **el equipo** correspondiente → Enviar.
   - Repite para cada equipo con su técnica. Si te equivocas de equipo, te avisa.
   - En **1–4 segundos** les aparece en la bandeja a todos los de ese equipo.
5. Observa el dashboard: el **embudo** (recibieron → abrieron → clic → cayeron) y
   la tabla **por técnica** se van llenando solos.
6. Al terminar: paso 2 → **"Marcar finalizada"** (habilita la encuesta para quien
   no pulsó "Finalizar piloto"). Cada participante hace la **encuesta** (adaptada
   a su técnica) y ve el **debriefing** que revela la simulación.

---

## 5. Después

- **Resultados**: dashboard `/index.html` (lectura rápida, embudo, por técnica,
  por rol, motivos). Exporta CSV desde `/api/export/by-team.csv` y
  `/api/export/by-role-vector.csv` (con la cabecera `x-api-key`).
- **Repetir una prueba** (mismos participantes): paso 2 → "Reiniciar campaña".
- **Copia de seguridad** de la base:
  `"C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" -h 127.0.0.1 -p 5434 -U paws paws_piloto > piloto_backup.sql`

---

## Resolución de problemas

| Síntoma | Causa habitual |
|---|---|
| Un PC no abre `http://<IP>:3000/...` | Cortafuegos de Windows en el PC admin, o no están en la misma red/Wi-Fi. Prueba `/health`. |
| El enlace dice "Enlace no válido" | Token mal copiado, o la base se reinició/truncó después de generar los enlaces. |
| El ataque no llega | ¿Enviaste al equipo correcto? ¿El participante tiene la pestaña abierta y visible? (el sondeo se pausa si la pestaña está oculta y se reanuda al volver). |
| El dashboard no se actualiza | Marca "actualizar solo". O pulsa "Cargar". |
| La tipografía se ve distinta | Los PC no tienen internet para "Inter"; usan la fuente del sistema. No afecta a nada. |
| "No autorizado" en el panel | Clave `ADMIN_API_KEY` incorrecta (la del `.env` del PC admin). |

## Privacidad (recordatorio)

El sistema **no guarda** nombres, correos, documentos, IP, ni el contenido de
ningún formulario o tarjeta. Lo que el participante escribe en el formulario de
"login" del ataque se descarta antes de tocar la base. El diálogo de permisos es
**simulado**: no accede a cámara, micro ni ubicación. Las tarjetas que crea el
participante viven solo en **su** navegador. El dashboard solo muestra datos
**agregados**.
