// Siembra datos SINTÉTICOS de demostración para que el dashboard tenga algo
// que mostrar antes del piloto real. Ningún dato aquí corresponde a una
// persona real — los external_hash son cadenas de ejemplo.
import "dotenv/config";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ROLES = ["estudiante", "estudiante", "estudiante", "profesor", "directivo"];
const VECTORS = ["autoridad", "urgencia", "escasez", "prueba_social", "curiosidad"];
const REASONS = ["miedo_sancion", "promesa_beneficio", "confianza_remitente", "urgencia_temporal", "prueba_social", "curiosidad"];
const TEAMS = ["Equipo 1", "Equipo 2", "Equipo 3", "Equipo 4", "Equipo 5"];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function main() {
  console.log("Sembrando datos de demostración...");

  // 1) una campaña demo + una plantilla y un mensaje de ataque por vector
  const camp = await pool.query(
    `INSERT INTO campaigns (name, seed, status) VALUES ('Campaña demo', 'demo-seed', 'finalizada') RETURNING id`
  );
  const campaignId = camp.rows[0].id;

  const messageByVector = {};
  for (const vector of VECTORS) {
    const t = await pool.query(
      `INSERT INTO templates (name, vector, channel, kind, is_attack, sender_label, subject_or_headline, message_body, cta_label, landing_kind)
       VALUES ($1,$2,'web','email',true,'Notificaciones',$3,$4,'Abrir','form') RETURNING id`,
      [`Plantilla demo — ${vector}`, vector, `Aviso simulado (${vector})`, `<p>Mensaje demo del vector <b>${vector}</b>.</p>`]
    );
    const m = await pool.query(
      `INSERT INTO messages (campaign_id, template_id, kind, is_attack, vector, sender_label, subject, body, cta_label, landing_kind)
       VALUES ($1,$2,'email',true,$3,'Notificaciones',$4,$5,'Abrir','form') RETURNING id`,
      [campaignId, t.rows[0].id, vector, `Aviso simulado (${vector})`, `<p>Mensaje demo del vector <b>${vector}</b>.</p>`]
    );
    messageByVector[vector] = m.rows[0].id;
  }

  let seq = 0;
  for (const team of TEAMS) {
    const size = 8 + Math.floor(Math.random() * 6);
    for (let i = 0; i < size; i++) {
      seq += 1;
      const hash = `demo_hash_${String(seq).padStart(4, "0")}`;
      const role = pick(ROLES);
      const p = await pool.query(
        `INSERT INTO participants (external_hash, role, team_label, group_assignment, consent_given, consent_timestamp)
         VALUES ($1,$2,$3,$4,true,now()) RETURNING id`,
        [hash, role, team, Math.random() < 0.5 ? "control" : "experimental"]
      );
      const pc = await pool.query(
        `INSERT INTO participant_campaign (participant_id, campaign_id, access_token, session_started_at, finished_at)
         VALUES ($1,$2,$3, now() - interval '1 hour', now() - interval '20 minutes') RETURNING id`,
        [p.rows[0].id, campaignId, `demo_${hash}`]
      );
      const pcId = pc.rows[0].id;

      const vector = pick(VECTORS);
      const messageId = messageByVector[vector];
      const del = await pool.query(
        `INSERT INTO deliveries (message_id, participant_campaign_id, delivered_at)
         VALUES ($1,$2, now() - interval '1 hour') RETURNING id`,
        [messageId, pcId]
      );
      const deliveryId = del.rows[0].id;
      const ev = (type, mins, rt = null) => pool.query(
        `INSERT INTO events (participant_campaign_id, delivery_id, event_type, occurred_at, reaction_time_ms)
         VALUES ($1,$2,$3, now() - ($4 || ' minutes')::interval, $5)`,
        [pcId, deliveryId, type, mins, rt]
      );

      await ev("entregado", 60);
      const opened = Math.random() < 0.85;
      if (!opened) continue;
      const rOpen = 3000 + Math.floor(Math.random() * 60000);
      await ev("abierto", 55, rOpen);

      const clicked = Math.random() < 0.35;
      let fell = false, reason = "no_aplica";
      if (clicked) {
        fell = true;
        reason = pick(REASONS);
        const rClick = rOpen + 1000 + Math.floor(Math.random() * 8000);
        await ev("clic", 50, rClick);
        if (Math.random() < 0.6) await ev("intento_envio", 49, rClick + 4000);
      } else if (Math.random() < 0.3) {
        await ev("reportado", 54);
      }

      await pool.query(
        `INSERT INTO post_session_survey
           (participant_campaign_id, primary_message_id, fell_for_attack, fall_reason, perceived_suspicion_before_action, recognized_as_simulated)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [pcId, messageId, fell, reason, Math.random() < 0.4, Math.random() < 0.2]
      );
    }
  }

  console.log(`Listo: ${seq} participantes sintéticos en ${TEAMS.length} equipos.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
