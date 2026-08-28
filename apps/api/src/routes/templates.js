import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

export const templatesRouter = Router();

const VALID_VECTORS = ["autoridad", "urgencia", "escasez", "prueba_social", "curiosidad"];
const VALID_CHANNELS = ["email_simulado", "sms_simulado", "web"];
const VALID_LANDING = ["form", "permiso"];

function validate(body) {
  const { name, vector, channel = "web", subject_or_headline, landing_kind = "form" } = body ?? {};
  if (!name || !VALID_VECTORS.includes(vector) || !VALID_CHANNELS.includes(channel) || !subject_or_headline) {
    return `Campos requeridos: name, vector (${VALID_VECTORS.join("|")}), channel (${VALID_CHANNELS.join("|")}), subject_or_headline`;
  }
  if (!VALID_LANDING.includes(landing_kind)) return `landing_kind inválido: ${landing_kind} (${VALID_LANDING.join("|")})`;
  return null;
}

function fields(body) {
  return [
    body.name,
    body.vector,
    body.channel ?? "web",
    body.sender_label ?? null,
    body.subject_or_headline,
    body.message_body ?? null,
    body.cta_label ?? "Abrir",
    body.landing_kind ?? "form",
    JSON.stringify(body.landing_config ?? {}),
    body.body_ref ?? null,
  ];
}

templatesRouter.post("/", requireAdmin, async (req, res) => {
  const err = validate(req.body);
  if (err) return res.status(400).json({ error: err });
  const result = await query(
    `INSERT INTO templates
       (name, vector, channel, sender_label, subject_or_headline, message_body, cta_label, landing_kind, landing_config, body_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,
    fields(req.body)
  );
  res.status(201).json({ template: result.rows[0] });
});

templatesRouter.get("/", requireAdmin, async (req, res) => {
  const result = await query(`SELECT * FROM templates ORDER BY vector, created_at DESC`);
  res.json({ templates: result.rows });
});

templatesRouter.get("/:id", requireAdmin, async (req, res) => {
  const result = await query(`SELECT * FROM templates WHERE id = $1`, [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: "Plantilla no encontrada" });
  res.json({ template: result.rows[0] });
});

templatesRouter.put("/:id", requireAdmin, async (req, res) => {
  const err = validate(req.body);
  if (err) return res.status(400).json({ error: err });
  const result = await query(
    `UPDATE templates SET
       name=$1, vector=$2, channel=$3, sender_label=$4, subject_or_headline=$5,
       message_body=$6, cta_label=$7, landing_kind=$8, landing_config=$9::jsonb, body_ref=$10
     WHERE id=$11 RETURNING *`,
    [...fields(req.body), req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Plantilla no encontrada" });
  res.json({ template: result.rows[0] });
});

templatesRouter.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const result = await query(`DELETE FROM templates WHERE id = $1 RETURNING id`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Plantilla no encontrada" });
    res.json({ deleted: result.rows[0].id });
  } catch (e) {
    res.status(409).json({ error: "No se puede borrar: la plantilla está en uso por una campaña." });
  }
});

// Crea de una vez las 5 plantillas estándar (una por vector) con contenido
// de ejemplo, para no tener que escribirlas a mano. Idempotente por nombre.
templatesRouter.post("/seed-defaults", requireAdmin, async (req, res) => {
  const defaults = [
    {
      name: "Autoridad — Coordinación Académica", vector: "autoridad",
      sender_label: "Coordinación Académica",
      subject_or_headline: "Confirmación obligatoria de datos antes de hoy 17:00",
      message_body: "<p>Estimado/a usuario/a,</p><p>Desde Coordinación necesitamos que <b>confirmes tus datos de acceso</b> antes de las 17:00 de hoy. Los accesos no confirmados se bloquearán de forma automática.</p><p>Gracias por tu colaboración.</p>",
      cta_label: "Confirmar mis datos", landing_kind: "form",
      landing_config: { titulo: "Confirmación de datos", detalle: "Introduce tus datos de acceso para confirmar tu cuenta." },
    },
    {
      name: "Urgencia — Sesión por expirar", vector: "urgencia",
      sender_label: "Seguridad TaskFlow",
      subject_or_headline: "Tu sesión expirará en 10 minutos",
      message_body: "<p>Hemos detectado actividad inusual. Por seguridad, <b>tu sesión se cerrará en 10 minutos</b> salvo que vuelvas a verificar tu identidad ahora.</p>",
      cta_label: "Verificar ahora", landing_kind: "form",
      landing_config: { titulo: "Verificación de seguridad", detalle: "Vuelve a introducir tus credenciales para mantener la sesión activa." },
    },
    {
      name: "Escasez — Cupos de capacitación", vector: "escasez",
      sender_label: "Formación Interna",
      subject_or_headline: "Últimos 3 cupos para la capacitación certificada",
      message_body: "<p>Quedan <b>solo 3 cupos</b> para la capacitación certificada de este mes. Reserva el tuyo antes de que se agoten.</p>",
      cta_label: "Reservar mi cupo", landing_kind: "form",
      landing_config: { titulo: "Reserva de cupo", detalle: "Identifícate para reservar tu lugar en la capacitación." },
    },
    {
      name: "Prueba social — Tus compañeros ya confirmaron", vector: "prueba_social",
      sender_label: "Equipo TaskFlow",
      subject_or_headline: "12 de 15 personas de tu equipo ya completaron el paso",
      message_body: "<p><b>12 de 15 compañeros</b> de tu equipo ya han completado la verificación de este trimestre. Solo faltas tú y dos personas más.</p>",
      cta_label: "Completar como los demás", landing_kind: "form",
      landing_config: { titulo: "Verificación trimestral", detalle: "Completa el mismo paso que ya hicieron tus compañeros." },
    },
    {
      name: "Curiosidad — Documento compartido", vector: "curiosidad",
      sender_label: "Documentos compartidos",
      subject_or_headline: "Alguien compartió contigo el archivo \"Evaluaciones y ajustes Q3\"",
      message_body: "<p>Se ha compartido contigo un documento: <b>\"Evaluaciones y ajustes Q3\"</b>. Ábrelo para ver el contenido.</p>",
      cta_label: "Ver documento", landing_kind: "permiso",
      landing_config: { permiso: "calendario", titulo: "TaskFlow quiere acceder a tu calendario", detalle: "El documento contiene invitaciones a reuniones. Permite el acceso al calendario para abrirlas." },
    },
  ];

  const created = [];
  for (const d of defaults) {
    const exists = await query(`SELECT id FROM templates WHERE name = $1`, [d.name]);
    if (exists.rows.length > 0) { created.push({ ...exists.rows[0], skipped: true }); continue; }
    const r = await query(
      `INSERT INTO templates
         (name, vector, channel, sender_label, subject_or_headline, message_body, cta_label, landing_kind, landing_config, body_ref)
       VALUES ($1,$2,'web',$3,$4,$5,$6,$7,$8::jsonb,null) RETURNING id, name, vector`,
      [d.name, d.vector, d.sender_label, d.subject_or_headline, d.message_body, d.cta_label, d.landing_kind, JSON.stringify(d.landing_config)]
    );
    created.push(r.rows[0]);
  }
  res.status(201).json({ templates: created });
});
