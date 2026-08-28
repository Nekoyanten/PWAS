// Siembra datos SINTÉTICOS de demostración para que el dashboard tenga algo
// que mostrar antes de correr el piloto real. Ningún dato aquí corresponde
// a una persona real — los external_hash son cadenas de ejemplo, no hashes
// de identidades reales.
import "dotenv/config";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ROLES = ["estudiante", "estudiante", "estudiante", "profesor", "directivo"];
const VECTORS = ["autoridad", "urgencia", "escasez", "prueba_social", "curiosidad"];
const REASONS = ["miedo_sancion", "promesa_beneficio", "confianza_remitente", "urgencia_temporal", "prueba_social", "curiosidad"];
const TEAMS = ["Equipo 1", "Equipo 2", "Equipo 3", "Equipo 4", "Equipo 5"];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function main() {
  console.log("Sembrando datos de demostración...");

  const templateIds = [];
  for (const vector of VECTORS) {
    const r = await pool.query(
      `INSERT INTO templates (name, vector, channel, subject_or_headline, body_ref)
       VALUES ($1, $2, 'web', $3, 'demo-template') RETURNING id`,
      [`Plantilla demo — ${vector}`, vector, `Aviso simulado (${vector})`]
    );
    templateIds.push({ id: r.rows[0].id, vector });
  }

  const campaignIds = [];
  for (const t of templateIds) {
    const r = await pool.query(
      `INSERT INTO campaigns (name, template_id, status) VALUES ($1, $2, 'finalizada') RETURNING id`,
      [`Campaña demo — ${t.vector}`, t.id]
    );
    campaignIds.push({ id: r.rows[0].id, vector: t.vector });
  }

  let seq = 0;
  for (const team of TEAMS) {
    const teamSize = 8 + Math.floor(Math.random() * 6); // 8-13 por equipo
    for (let i = 0; i < teamSize; i++) {
      seq += 1;
      const hash = `demo_hash_${String(seq).padStart(4, "0")}`;
      const role = pick(ROLES);
      const pRes = await pool.query(
        `INSERT INTO participants (external_hash, role, team_label, group_assignment, consent_given, consent_timestamp)
         VALUES ($1, $2, $3, $4, true, now()) RETURNING id`,
        [hash, role, team, Math.random() < 0.5 ? "control" : "experimental"]
      );
      const participantId = pRes.rows[0].id;

      // cada participante pasa por 1-2 campañas
      const numCampaigns = 1 + Math.floor(Math.random() * 2);
      const shuffled = [...campaignIds].sort(() => Math.random() - 0.5).slice(0, numCampaigns);

      for (const camp of shuffled) {
        const token = `demo_${hash}_${camp.id.slice(0, 6)}`;
        const pcRes = await pool.query(
          `INSERT INTO participant_campaign (participant_id, campaign_id, access_token, delivered_at)
           VALUES ($1, $2, $3, now() - interval '1 hour') RETURNING id`,
          [participantId, camp.id, token]
        );
        const pcId = pcRes.rows[0].id;

        await pool.query(`INSERT INTO events (participant_campaign_id, event_type, occurred_at) VALUES ($1, 'entregado', now() - interval '1 hour')`, [pcId]);

        const opened = Math.random() < 0.85;
        if (!opened) continue;
        const reactionOpen = 3000 + Math.floor(Math.random() * 60000);
        await pool.query(
          `INSERT INTO events (participant_campaign_id, event_type, occurred_at, reaction_time_ms) VALUES ($1, 'abierto', now() - interval '55 minutes', $2)`,
          [pcId, reactionOpen]
        );

        const clicked = Math.random() < 0.35; // tasa de caída sintética ~35%
        let fell = false;
        let reason = "no_aplica";
        if (clicked) {
          fell = true;
          reason = pick(REASONS);
          const reactionClick = reactionOpen + 1000 + Math.floor(Math.random() * 8000);
          await pool.query(
            `INSERT INTO events (participant_campaign_id, event_type, occurred_at, reaction_time_ms) VALUES ($1, 'clic', now() - interval '50 minutes', $2)`,
            [pcId, reactionClick]
          );
          if (Math.random() < 0.6) {
            await pool.query(
              `INSERT INTO events (participant_campaign_id, event_type, occurred_at, reaction_time_ms) VALUES ($1, 'intento_envio', now() - interval '49 minutes', $2)`,
              [pcId, reactionClick + 4000]
            );
          }
        } else if (Math.random() < 0.3) {
          await pool.query(`INSERT INTO events (participant_campaign_id, event_type, occurred_at) VALUES ($1, 'reportado', now() - interval '54 minutes')`, [pcId]);
        }

        await pool.query(
          `INSERT INTO post_session_survey (participant_campaign_id, fell_for_attack, fall_reason, perceived_suspicion_before_action, recognized_as_simulated)
           VALUES ($1, $2, $3, $4, $5)`,
          [pcId, fell, reason, Math.random() < 0.4, Math.random() < 0.2]
        );
      }
    }
  }

  console.log(`Listo: ${seq} participantes sintéticos sembrados en ${TEAMS.length} equipos.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
