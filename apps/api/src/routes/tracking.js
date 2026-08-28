import { Router } from "express";
import { query } from "../db.js";

export const trackingRouter = Router();

// Todas las rutas de este archivo son PÚBLICAS (las visita el participante,
// no un administrador) y de propósito único: solo aceptan el token opaco,
// nunca un identificador de participante legible. No requieren x-api-key.

async function loadParticipantCampaign(token) {
  const result = await query(
    `SELECT pc.id, pc.delivered_at, pc.campaign_id, c.template_id, t.channel, t.subject_or_headline
     FROM participant_campaign pc
     JOIN campaigns c ON c.id = pc.campaign_id
     JOIN templates t ON t.id = c.template_id
     WHERE pc.access_token = $1`,
    [token]
  );
  return result.rows[0] ?? null;
}

async function reactionTimeMs(pc) {
  if (!pc.delivered_at) return null;
  return Date.now() - new Date(pc.delivered_at).getTime();
}

async function recordEventOnce(participantCampaignId, eventType, reactionTimeMs = null) {
  // Evita duplicar el mismo tipo de evento si el participante recarga la página.
  const existing = await query(
    `SELECT id FROM events WHERE participant_campaign_id = $1 AND event_type = $2`,
    [participantCampaignId, eventType]
  );
  if (existing.rows.length > 0) return existing.rows[0];
  const result = await query(
    `INSERT INTO events (participant_campaign_id, event_type, reaction_time_ms)
     VALUES ($1, $2, $3) RETURNING *`,
    [participantCampaignId, eventType, reactionTimeMs]
  );
  return result.rows[0];
}

// 1) Apertura del estímulo — registra 'abierto' y muestra la página señuelo.
trackingRouter.get("/:token", async (req, res) => {
  const pc = await loadParticipantCampaign(req.params.token);
  if (!pc) return res.status(404).send("Enlace no válido o vencido.");

  await recordEventOnce(pc.id, "abierto", await reactionTimeMs(pc));

  res.render_decoy = true;
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderDecoyPage(req.params.token, pc.subject_or_headline));
});

// 2) Clic en el botón/enlace de acción de la página señuelo.
trackingRouter.get("/:token/click", async (req, res) => {
  const pc = await loadParticipantCampaign(req.params.token);
  if (!pc) return res.status(404).send("Enlace no válido o vencido.");

  await recordEventOnce(pc.id, "clic", await reactionTimeMs(pc));

  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderDecoyFormPage(req.params.token));
});

// 3) Intento de envío del formulario señuelo. NO recibe ni procesa valores de
// campos: el frontend de la página señuelo NO debe incluir el contenido de
// los inputs en este request (ver public/decoy-form.js). Aunque llegara algo
// en el body por error de implementación futura, este endpoint lo ignora
// deliberadamente y nunca lo persiste.
trackingRouter.post("/:token/submit", async (req, res) => {
  const pc = await loadParticipantCampaign(req.params.token);
  if (!pc) return res.status(404).json({ error: "Enlace no válido o vencido." });

  await recordEventOnce(pc.id, "intento_envio", await reactionTimeMs(pc));

  res.json({ ok: true, message: "Registrado. Ningún dato ingresado fue almacenado." });
});

// 4) El participante reporta el estímulo como sospechoso (señal positiva,
// mide reconocimiento — TG Objetivos específicos / RQ de reconocimiento).
trackingRouter.post("/:token/report", async (req, res) => {
  const pc = await loadParticipantCampaign(req.params.token);
  if (!pc) return res.status(404).json({ error: "Enlace no válido o vencido." });

  await recordEventOnce(pc.id, "reportado", await reactionTimeMs(pc));
  res.json({ ok: true });
});

// 5) Encuesta post-sesión / debriefing (TG §9.5 Paso 6). fell_for_attack se
// calcula del lado del servidor a partir de los eventos reales (no se confía
// en un autorreporte para ese dato); fall_reason y las demás sí son
// autoinformadas por el participante durante el debriefing.
trackingRouter.post("/:token/survey", async (req, res) => {
  const pc = await loadParticipantCampaign(req.params.token);
  if (!pc) return res.status(404).json({ error: "Enlace no válido o vencido." });

  const { fall_reason, perceived_suspicion_before_action, recognized_as_simulated } = req.body ?? {};

  const fellRes = await query(
    `SELECT EXISTS (
       SELECT 1 FROM events WHERE participant_campaign_id = $1 AND event_type IN ('clic', 'intento_envio')
     ) AS fell`,
    [pc.id]
  );
  const fellForAttack = fellRes.rows[0].fell;

  const result = await query(
    `INSERT INTO post_session_survey
       (participant_campaign_id, fell_for_attack, fall_reason, perceived_suspicion_before_action, recognized_as_simulated)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (participant_campaign_id) DO UPDATE SET
       fell_for_attack = EXCLUDED.fell_for_attack,
       fall_reason = EXCLUDED.fall_reason,
       perceived_suspicion_before_action = EXCLUDED.perceived_suspicion_before_action,
       recognized_as_simulated = EXCLUDED.recognized_as_simulated
     RETURNING *`,
    [pc.id, fellForAttack, fall_reason ?? "no_aplica", perceived_suspicion_before_action ?? null, recognized_as_simulated ?? null]
  );

  res.status(201).json({ survey: result.rows[0] });
});

// ----------------------------------------------------------------------------
// Páginas señuelo mínimas de ejemplo. Branding deliberadamente GENÉRICO/
// FICTICIO ("Portal Académico") — PS §3.2 prohíbe suplantar una identidad
// real específica. Reemplazar el contenido visual en templates.body_ref para
// cada escenario real sin tocar este archivo.
function renderDecoyPage(token, headline) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>${escapeHtml(headline || "Portal Académico")}</title>
<style>${sharedStyles()}</style></head><body>
<div class="card">
  <h1>${escapeHtml(headline || "Aviso del Portal Académico")}</h1>
  <p>Este es un mensaje simulado dentro de un ejercicio académico autorizado.</p>
  <a class="btn" href="/t/${encodeURIComponent(token)}/click">Verificar cuenta</a>
</div>
</body></html>`;
}

function renderDecoyFormPage(token) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Portal Académico — Verificación</title>
<style>${sharedStyles()}</style></head><body>
<div class="card">
  <h1>Verificación de cuenta</h1>
  <form id="f">
    <label>Usuario<input type="text" name="user" autocomplete="off"></label>
    <label>Contraseña<input type="password" name="pass" autocomplete="off"></label>
    <button class="btn" type="submit">Enviar</button>
  </form>
  <p id="msg"></p>
</div>
<script>
// IMPORTANTE: deliberadamente NO se leen ni se envían los valores de los
// campos. Solo se notifica el evento "se intentó enviar".
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  e.target.reset();
  const res = await fetch('/t/${token}/submit', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
  document.getElementById('msg').textContent = res.ok ? 'Registrado (fin de la simulación).' : 'Error al registrar.';
});
</script>
</body></html>`;
}

function sharedStyles() {
  return `body{font-family:system-ui,sans-serif;background:#f4f6fb;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;padding:2rem 2.5rem;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.08);max-width:420px}
h1{font-size:1.25rem;color:#1f3864}
label{display:block;margin:.75rem 0;font-size:.9rem;color:#333}
input{width:100%;padding:.5rem;margin-top:.25rem;border:1px solid #ccc;border-radius:6px;box-sizing:border-box}
.btn{display:inline-block;margin-top:1rem;background:#2e74b5;color:#fff;padding:.6rem 1.2rem;border:none;border-radius:6px;cursor:pointer;text-decoration:none;font-size:.95rem}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
