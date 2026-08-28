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

// Crea el juego estándar: 5 plantillas de ataque (una por vector) + 2 mensajes
// benignos de relleno (un correo y una tarea). Idempotente por nombre.
templatesRouter.post("/seed-defaults", requireAdmin, async (req, res) => {
  const defaults = [
    { name: "Autoridad — Coordinación Académica", vector: "autoridad", kind: "email", is_attack: true,
      sender_label: "Coordinación Académica",
      subject_or_headline: "Confirmación obligatoria de datos antes de hoy 17:00",
      message_body: "<p>Estimado/a usuario/a,</p><p>Desde Coordinación necesitamos que <b>confirmes tus datos de acceso</b> antes de las 17:00 de hoy. Los accesos no confirmados se bloquearán automáticamente.</p>",
      cta_label: "Confirmar mis datos", landing_kind: "form",
      landing_config: { titulo: "Confirmación de datos", detalle: "Introduce tus datos de acceso para confirmar tu cuenta." } },

    { name: "Urgencia — Sesión por expirar", vector: "urgencia", kind: "email", is_attack: true,
      sender_label: "Seguridad TaskFlow",
      subject_or_headline: "Tu sesión expirará en 10 minutos",
      message_body: "<p>Hemos detectado actividad inusual. Por seguridad, <b>tu sesión se cerrará en 10 minutos</b> salvo que verifiques tu identidad ahora.</p>",
      cta_label: "Verificar ahora", landing_kind: "form",
      landing_config: { titulo: "Verificación de seguridad", detalle: "Vuelve a introducir tus credenciales para mantener la sesión activa." } },

    { name: "Escasez — Cupos de capacitación", vector: "escasez", kind: "email", is_attack: true,
      sender_label: "Formación Interna",
      subject_or_headline: "Últimos 3 cupos para la capacitación certificada",
      message_body: "<p>Quedan <b>solo 3 cupos</b> para la capacitación certificada de este mes. Reserva el tuyo antes de que se agoten.</p>",
      cta_label: "Reservar mi cupo", landing_kind: "form",
      landing_config: { titulo: "Reserva de cupo", detalle: "Identifícate para reservar tu lugar." } },

    { name: "Prueba social — Tus compañeros ya confirmaron", vector: "prueba_social", kind: "task", is_attack: true,
      sender_label: "Equipo TaskFlow",
      subject_or_headline: "12 de 15 personas de tu equipo ya completaron este paso",
      message_body: "<p><b>12 de 15 compañeros</b> de tu equipo ya completaron la verificación de este trimestre. Solo faltan dos personas y tú.</p>",
      cta_label: "Completar como los demás", landing_kind: "form",
      landing_config: { titulo: "Verificación trimestral", detalle: "Completa el mismo paso que ya hicieron tus compañeros." } },

    { name: "Curiosidad — Documento compartido", vector: "curiosidad", kind: "email", is_attack: true,
      sender_label: "Documentos compartidos",
      subject_or_headline: "Alguien compartió contigo \"Evaluaciones y ajustes Q3\"",
      message_body: "<p>Se ha compartido contigo un documento: <b>\"Evaluaciones y ajustes Q3\"</b>. Autoriza el acceso para abrirlo.</p>",
      cta_label: "Ver documento", landing_kind: "permiso",
      landing_config: { scope: "archivos", titulo: "Una aplicación externa solicita acceso a tus archivos de TaskFlow", detalle: "Abrir documentos compartidos por terceros" } },

    { name: "Benigno — Bienvenida (correo)", vector: "autoridad", kind: "email", is_attack: false,
      sender_label: "Equipo TaskFlow",
      subject_or_headline: "Bienvenido/a al piloto de TaskFlow",
      message_body: "Gracias por participar. Usa el tablero con normalidad: mueve tarjetas, marca tareas como hechas y revisa esta bandeja. Cuando termines, pulsa \"Finalizar piloto\"." },

    { name: "Benigno — Reunión de seguimiento (tarea)", vector: "autoridad", kind: "task", is_attack: false,
      sender_label: "Calendario del equipo",
      subject_or_headline: "Preparar la reunión de seguimiento del viernes",
      message_body: "Actualiza tus tarjetas del tablero antes de la reunión semanal del viernes a las 10:00." },
  ];

  const created = [];
  for (const d of defaults) {
    const exists = await query(`SELECT id, name, vector FROM templates WHERE name = $1`, [d.name]);
    if (exists.rows.length > 0) { created.push({ ...exists.rows[0], skipped: true }); continue; }
    const r = await query(
      `INSERT INTO templates ${INSERT_COLS} VALUES ${INSERT_VALS} RETURNING id, name, vector, kind, is_attack`,
      fields(d)
    );
    created.push(r.rows[0]);
  }
  res.status(201).json({ templates: created });
});
