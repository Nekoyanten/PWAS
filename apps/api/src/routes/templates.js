import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

export const templatesRouter = Router();

const VECTORS = ["autoridad", "urgencia", "escasez", "prueba_social", "curiosidad"];
const CHANNELS = ["email_simulado", "sms_simulado", "web"];
const LANDINGS = ["form", "permiso"];
const KINDS = ["email", "task"];

function validate(b) {
  if (!b?.name || !b?.subject_or_headline) return "Campos requeridos: name, subject_or_headline";
  const isAttack = b.is_attack !== false;
  if (isAttack && !VECTORS.includes(b.vector)) return `vector inválido (${VECTORS.join("|")})`;
  if (b.channel && !CHANNELS.includes(b.channel)) return `channel inválido (${CHANNELS.join("|")})`;
  if (b.kind && !KINDS.includes(b.kind)) return `kind inválido (${KINDS.join("|")})`;
  if (isAttack && b.landing_kind && !LANDINGS.includes(b.landing_kind)) return `landing_kind inválido (${LANDINGS.join("|")})`;
  return null;
}

function fields(b) {
  const isAttack = b.is_attack !== false;
  return [
    b.name,
    isAttack ? b.vector : (b.vector && VECTORS.includes(b.vector) ? b.vector : "autoridad"), // vector NOT NULL en el esquema; para no-ataque es un valor de relleno ignorado
    b.channel ?? "web",
    b.kind ?? "email",
    isAttack,
    b.sender_label ?? null,
    b.subject_or_headline,
    b.message_body ?? null,
    b.cta_label ?? "Abrir",
    isAttack ? (b.landing_kind ?? "form") : "form",
    JSON.stringify(b.landing_config ?? {}),
    b.body_ref ?? null,
  ];
}

const INSERT_COLS = `(name, vector, channel, kind, is_attack, sender_label, subject_or_headline, message_body, cta_label, landing_kind, landing_config, body_ref)`;
const INSERT_VALS = `($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`;

templatesRouter.post("/", requireAdmin, async (req, res) => {
  const err = validate(req.body);
  if (err) return res.status(400).json({ error: err });
  const r = await query(`INSERT INTO templates ${INSERT_COLS} VALUES ${INSERT_VALS} RETURNING *`, fields(req.body));
  res.status(201).json({ template: r.rows[0] });
});

templatesRouter.get("/", requireAdmin, async (req, res) => {
  const r = await query(`SELECT * FROM templates ORDER BY is_attack DESC, vector, created_at DESC`);
  res.json({ templates: r.rows });
});

templatesRouter.get("/:id", requireAdmin, async (req, res) => {
  const r = await query(`SELECT * FROM templates WHERE id = $1`, [req.params.id]);
  if (r.rows.length === 0) return res.status(404).json({ error: "Plantilla no encontrada" });
  res.json({ template: r.rows[0] });
});

templatesRouter.put("/:id", requireAdmin, async (req, res) => {
  const err = validate(req.body);
  if (err) return res.status(400).json({ error: err });
  const r = await query(
    `UPDATE templates SET
       name=$1, vector=$2, channel=$3, kind=$4, is_attack=$5, sender_label=$6, subject_or_headline=$7,
       message_body=$8, cta_label=$9, landing_kind=$10, landing_config=$11::jsonb, body_ref=$12
     WHERE id=$13 RETURNING *`,
    [...fields(req.body), req.params.id]
  );
  if (r.rows.length === 0) return res.status(404).json({ error: "Plantilla no encontrada" });
  res.json({ template: r.rows[0] });
});

templatesRouter.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const r = await query(`DELETE FROM templates WHERE id = $1 RETURNING id`, [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Plantilla no encontrada" });
    res.json({ deleted: r.rows[0].id });
  } catch {
    res.status(409).json({ error: "No se puede borrar: la plantilla está en uso." });
  }
});

// Biblioteca estándar: 15 plantillas de ataque (3 por cada una de las 5 técnicas)
// con escenarios de phishing habituales + 6 mensajes benignos de relleno
// realista. Idempotente por nombre. Con { replace: true } (o ?replace=1)
// reescribe las que ya existan en vez de saltarlas.
export const STANDARD_LIBRARY = [
  // ---------- AUTORIDAD ----------
  { name: "Autoridad — Soporte TI: verificación obligatoria", vector: "autoridad", kind: "email", is_attack: true,
    sender_label: "Soporte TI",
    subject_or_headline: "Acción requerida: verifica tu cuenta antes de las 17:00",
    message_body: "<p>Estimado/a usuario/a,</p><p>El área de <b>Soporte TI</b> está migrando el sistema de acceso. Para no perder el servicio, <b>verifica tu cuenta hoy antes de las 17:00</b>. Las cuentas sin verificar se suspenderán de forma temporal.</p><p>Gracias por tu colaboración.</p>",
    cta_label: "Verificar mi cuenta", landing_kind: "form",
    landing_config: { titulo: "Verificación de cuenta", detalle: "Confirma tu usuario y contraseña para completar la migración." } },

  { name: "Autoridad — RRHH: cierre de nómina", vector: "autoridad", kind: "email", is_attack: true,
    sender_label: "Recursos Humanos",
    subject_or_headline: "Tu ficha de empleado está incompleta (cierre de nómina)",
    message_body: "<p>Hola,</p><p>Al preparar el <b>cierre de nómina</b> de este mes detectamos que faltan datos en tu ficha. Necesitamos que los completes <b>antes del cierre</b> para que tu pago no se retrase.</p>",
    cta_label: "Completar mi ficha", landing_kind: "form",
    landing_config: { titulo: "Datos de empleado", detalle: "Identifícate para acceder a tu ficha y actualizarla." } },

  { name: "Autoridad — Dirección: revisión de accesos", vector: "autoridad", kind: "task", is_attack: true,
    sender_label: "Dirección General",
    subject_or_headline: "Revisión de accesos ordenada por Dirección",
    message_body: "<p>Por instrucción de <b>Dirección General</b>, se está auditando quién tiene acceso a cada tablero. Autoriza la revisión de tu cuenta para dejar constancia de que tus permisos son correctos.</p>",
    cta_label: "Autorizar la revisión", landing_kind: "permiso",
    landing_config: { scope: "equipo", titulo: "La auditoría de Dirección solicita revisar tu cuenta de TaskFlow", detalle: "Ver la lista de miembros y tableros de tu equipo" } },

  // ---------- URGENCIA ----------
  { name: "Urgencia — Seguridad: tu sesión expira en 10 minutos", vector: "urgencia", kind: "email", is_attack: true,
    sender_label: "Seguridad TaskFlow",
    subject_or_headline: "Actividad inusual: tu sesión se cerrará en 10 minutos",
    message_body: "<p>Hemos detectado un inicio de sesión desde un dispositivo desconocido. Por seguridad <b>tu sesión se cerrará en 10 minutos</b> salvo que confirmes que eres tú ahora mismo.</p>",
    cta_label: "Confirmar que soy yo", landing_kind: "form",
    landing_config: { titulo: "Confirmación de identidad", detalle: "Vuelve a introducir tus credenciales para mantener la sesión activa." } },

  { name: "Urgencia — TI: bloqueo de cuenta en 1 hora", vector: "urgencia", kind: "email", is_attack: true,
    sender_label: "Soporte TI",
    subject_or_headline: "Tu cuenta se bloqueará en 1 hora por falta de uso",
    message_body: "<p>Nuestros registros indican que tu cuenta lleva tiempo inactiva. <b>Se bloqueará automáticamente en 1 hora.</b> Si necesitas conservarla, reactívala ahora.</p>",
    cta_label: "Reactivar ahora", landing_kind: "form",
    landing_config: { titulo: "Reactivación de cuenta", detalle: "Introduce tus datos de acceso para reactivar tu cuenta." } },

  { name: "Urgencia — Finanzas: pago rechazado, regulariza hoy", vector: "urgencia", kind: "email", is_attack: true,
    sender_label: "Finanzas",
    subject_or_headline: "Pago rechazado — debes regularizarlo hoy",
    message_body: "<p>El último pago asociado a tu área <b>fue rechazado</b>. Si no se regulariza <b>hoy</b>, el servicio quedará suspendido para todo tu equipo. Revisa el detalle y confirma tus datos.</p>",
    cta_label: "Revisar el pago", landing_kind: "form",
    landing_config: { titulo: "Regularización de pago", detalle: "Identifícate para ver el detalle del pago rechazado." } },

  // ---------- ESCASEZ ----------
  { name: "Escasez — Formación: últimos 3 cupos (certificación)", vector: "escasez", kind: "email", is_attack: true,
    sender_label: "Formación Interna",
    subject_or_headline: "Últimos 3 cupos: certificación gratuita este mes",
    message_body: "<p>Quedan <b>solo 3 cupos</b> para la certificación gratuita de este mes. Se asignan por orden de reserva. Guarda el tuyo antes de que se agoten.</p>",
    cta_label: "Reservar mi cupo", landing_kind: "form",
    landing_config: { titulo: "Reserva de cupo", detalle: "Identifícate para reservar tu lugar en la certificación." } },

  { name: "Escasez — Beneficios: bono antes del viernes", vector: "escasez", kind: "email", is_attack: true,
    sender_label: "Beneficios al Personal",
    subject_or_headline: "Tu bono de productividad caduca el viernes",
    message_body: "<p>Tienes un <b>bono de productividad sin reclamar</b>. Solo se puede canjear <b>hasta el viernes</b>; después se pierde. Reclámalo en un minuto.</p>",
    cta_label: "Reclamar mi bono", landing_kind: "form",
    landing_config: { titulo: "Reclamar bono", detalle: "Confirma tu identidad para asignarte el bono." } },

  { name: "Escasez — TI: plazas limitadas para el nuevo portal", vector: "escasez", kind: "task", is_attack: true,
    sender_label: "Soporte TI",
    subject_or_headline: "Plazas limitadas para el acceso anticipado al nuevo portal",
    message_body: "<p>Estamos abriendo el <b>acceso anticipado</b> al nuevo portal a un número limitado de personas. Autoriza tu cuenta para quedar en la lista antes de que se llene.</p>",
    cta_label: "Solicitar acceso anticipado", landing_kind: "permiso",
    landing_config: { scope: "perfil", titulo: "El nuevo portal solicita acceso a tu cuenta de TaskFlow", detalle: "Ver tu nombre y foto de perfil" } },

  // ---------- PRUEBA SOCIAL ----------
  { name: "Prueba social — Equipo: 12 de 15 ya lo hicieron", vector: "prueba_social", kind: "task", is_attack: true,
    sender_label: "Equipo TaskFlow",
    subject_or_headline: "12 de 15 personas de tu equipo ya completaron este paso",
    message_body: "<p><b>12 de 15 compañeros</b> de tu equipo ya completaron la verificación de este trimestre. Solo faltan dos personas y tú.</p>",
    cta_label: "Completar como los demás", landing_kind: "form",
    landing_config: { titulo: "Verificación trimestral", detalle: "Completa el mismo paso que ya hicieron tus compañeros." } },

  { name: "Prueba social — RRHH: tu equipo ya firmó el código", vector: "prueba_social", kind: "email", is_attack: true,
    sender_label: "Recursos Humanos",
    subject_or_headline: "Tu equipo ya firmó el nuevo código de conducta — faltas tú",
    message_body: "<p>El nuevo <b>código de conducta</b> ya fue firmado por el resto de tu equipo. Eres la última persona pendiente. Fírmalo para cerrar el proceso.</p>",
    cta_label: "Firmar ahora", landing_kind: "form",
    landing_config: { titulo: "Firma del código de conducta", detalle: "Identifícate para registrar tu firma." } },

  { name: "Prueba social — TI: el 90% ya migró su autenticación", vector: "prueba_social", kind: "email", is_attack: true,
    sender_label: "Soporte TI",
    subject_or_headline: "El 90% del personal ya migró su autenticación",
    message_body: "<p>La mayoría del personal (<b>90%</b>) ya migró a la nueva autenticación sin problemas. Autoriza tu cuenta para unirte y no quedarte fuera del proceso.</p>",
    cta_label: "Migrar mi cuenta", landing_kind: "permiso",
    landing_config: { scope: "tareas", titulo: "El asistente de migración solicita acceso a tu cuenta de TaskFlow", detalle: "Ver y editar tus tareas y tableros" } },

  // ---------- CURIOSIDAD ----------
  { name: "Curiosidad — Documento compartido: 'Ajustes salariales Q3'", vector: "curiosidad", kind: "email", is_attack: true,
    sender_label: "Documentos compartidos",
    subject_or_headline: "Alguien compartió contigo \"Ajustes salariales Q3\"",
    message_body: "<p>Se ha compartido contigo un documento: <b>\"Ajustes salariales Q3\"</b>. Autoriza el acceso para poder abrirlo.</p>",
    cta_label: "Ver documento", landing_kind: "permiso",
    landing_config: { scope: "archivos", titulo: "Una aplicación de documentos solicita acceso a tus archivos de TaskFlow", detalle: "Abrir documentos que terceros comparten contigo" } },

  { name: "Curiosidad — Fotos del evento de la empresa", vector: "curiosidad", kind: "email", is_attack: true,
    sender_label: "Comunicación Interna",
    subject_or_headline: "Ya están las fotos del evento de la empresa",
    message_body: "<p>Subimos el <b>álbum de fotos</b> del último evento. Autoriza el acceso a la galería para verlas y descargar las tuyas.</p>",
    cta_label: "Ver el álbum", landing_kind: "permiso",
    landing_config: { scope: "archivos", titulo: "La galería de fotos solicita acceso a tus archivos de TaskFlow", detalle: "Ver y descargar archivos compartidos contigo" } },

  { name: "Curiosidad — Tienes un mensaje de voz sin escuchar", vector: "curiosidad", kind: "email", is_attack: true,
    sender_label: "Buzón de voz",
    subject_or_headline: "Tienes un mensaje de voz de 0:38 sin escuchar",
    message_body: "<p>Recibiste un <b>mensaje de voz</b> (0:38) que aún no has escuchado. Inicia sesión para reproducirlo.</p>",
    cta_label: "Escuchar el mensaje", landing_kind: "form",
    landing_config: { titulo: "Buzón de voz", detalle: "Inicia sesión para escuchar tu mensaje." } },

  // ---------- BENIGNOS (relleno realista, sin página trampa) ----------
  { name: "Relleno — Bienvenida al piloto", vector: "autoridad", kind: "email", is_attack: false,
    sender_label: "Equipo TaskFlow",
    subject_or_headline: "Bienvenido/a a TaskFlow",
    message_body: "Gracias por participar. Usa el tablero con normalidad: mueve tarjetas, marca tareas como hechas y revisa esta bandeja de vez en cuando. Cuando termines, pulsa \"Finalizar piloto\"." },

  { name: "Relleno — Reunión de seguimiento del viernes", vector: "autoridad", kind: "task", is_attack: false,
    sender_label: "Calendario del equipo",
    subject_or_headline: "Preparar la reunión de seguimiento del viernes",
    message_body: "Actualiza tus tarjetas del tablero antes de la reunión semanal del viernes a las 10:00. No hace falta enviar nada, solo dejar el tablero al día." },

  { name: "Relleno — Boletín interno del mes", vector: "autoridad", kind: "email", is_attack: false,
    sender_label: "Comunicación Interna",
    subject_or_headline: "Boletín interno — resumen del mes",
    message_body: "Resumen breve del mes: nuevas funciones del tablero, próximas fechas y un recordatorio de buenas prácticas para organizar las tarjetas por prioridad." },

  { name: "Relleno — Recordatorio: actualiza el tablero", vector: "autoridad", kind: "task", is_attack: false,
    sender_label: "TaskFlow",
    subject_or_headline: "Recordatorio: mueve tus tarjetas completadas a \"Hecho\"",
    message_body: "Tienes tarjetas que siguen en \"En progreso\" desde hace días. Si ya están terminadas, muévelas a \"Hecho\" para mantener el tablero al día." },

  { name: "Relleno — Encuesta de clima laboral", vector: "autoridad", kind: "email", is_attack: false,
    sender_label: "Recursos Humanos",
    subject_or_headline: "Encuesta de clima laboral (voluntaria y anónima)",
    message_body: "Este mes hacemos la encuesta de clima laboral. Es voluntaria y anónima; no hace falta que hagas nada dentro de esta aplicación." },

  { name: "Relleno — Mantenimiento programado del sistema", vector: "autoridad", kind: "email", is_attack: false,
    sender_label: "Soporte TI",
    subject_or_headline: "Mantenimiento programado el sábado de 2:00 a 4:00",
    message_body: "El sábado por la madrugada el sistema estará en mantenimiento entre las 2:00 y las 4:00. No necesitas hacer nada; tus tarjetas seguirán ahí después." },
];

templatesRouter.post("/seed-defaults", requireAdmin, async (req, res) => {
  const replace = req.body?.replace === true || req.query.replace === "1";
  const created = [];
  for (const d of STANDARD_LIBRARY) {
    const exists = await query(`SELECT id FROM templates WHERE name = $1`, [d.name]);
    if (exists.rows.length > 0) {
      if (!replace) { created.push({ id: exists.rows[0].id, name: d.name, skipped: true }); continue; }
      const u = await query(
        `UPDATE templates SET
           name=$1, vector=$2, channel=$3, kind=$4, is_attack=$5, sender_label=$6, subject_or_headline=$7,
           message_body=$8, cta_label=$9, landing_kind=$10, landing_config=$11::jsonb, body_ref=$12
         WHERE id=$13 RETURNING id, name, vector, kind, is_attack`,
        [...fields(d), exists.rows[0].id]
      );
      created.push({ ...u.rows[0], replaced: true });
      continue;
    }
    const r = await query(
      `INSERT INTO templates ${INSERT_COLS} VALUES ${INSERT_VALS} RETURNING id, name, vector, kind, is_attack`,
      fields(d)
    );
    created.push(r.rows[0]);
  }
  res.status(201).json({ templates: created, total: created.length });
});
