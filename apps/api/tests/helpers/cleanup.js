import { pool } from "../../src/db.js";

// Borra los datos que crean las suites de integración. Se identifican por llevar
// un timestamp (Date.now(), 13 dígitos) en el nombre / external_hash. NO toca la
// biblioteca estándar de plantillas ni ningún dato real del piloto.
export async function cleanupTestData() {
  const camps = `(SELECT id FROM campaigns WHERE name ~ '[0-9]{10,}')`;
  const parts = `(SELECT id FROM participants WHERE external_hash ~ '[0-9]{10,}')`;
  const pcs = `(SELECT id FROM participant_campaign WHERE campaign_id IN ${camps} OR participant_id IN ${parts})`;
  await pool.query(`DELETE FROM events WHERE participant_campaign_id IN ${pcs}`);
  await pool.query(`DELETE FROM post_session_survey WHERE participant_campaign_id IN ${pcs}`);
  await pool.query(`DELETE FROM deliveries WHERE participant_campaign_id IN ${pcs}`);
  await pool.query(`DELETE FROM participant_campaign WHERE campaign_id IN ${camps} OR participant_id IN ${parts}`);
  await pool.query(`DELETE FROM messages WHERE campaign_id IN ${camps}`);
  await pool.query(`DELETE FROM campaign_templates WHERE campaign_id IN ${camps}`);
  await pool.query(`DELETE FROM campaigns WHERE id IN ${camps}`);
  await pool.query(`DELETE FROM participants WHERE id IN ${parts}`);
  await pool.query(`DELETE FROM templates WHERE name ~ '^(Auth|R) [0-9]{10,}$'`);
}
