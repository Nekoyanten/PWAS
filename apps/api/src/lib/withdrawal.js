// Retiro de datos post-sesión (TG §9.1: la participación es "revocable en
// cualquier momento sin consecuencia alguna"). Antes de este módulo esa
// promesa solo se cumplía DURANTE la sesión, vía la casilla de
// consentimiento (dejar de marcarla, o cerrar la pestaña) — no existía
// ninguna manera de que un participante pidiera borrar sus datos después de
// que la sesión había terminado. Hallazgo 4.2 del informe de revisión
// crítica del 12 de septiembre de 2026.
//
// El borrado es un solo DELETE: todas las tablas de datos de sesión
// (deliveries, events, post_session_survey, behavior_sessions/events/
// features, facial_sessions/events/features, boards/board_columns/
// board_tasks, chat_threads/chat_messages) tienen
// `participant_campaign_id ... ON DELETE CASCADE` hacia participant_campaign
// (ver db/schema.sql y las migraciones 004, 008, 010, 015) — el mismo patrón
// de dos capas que ya se documentó para la captura conductual y facial hace
// que este borrado no tenga que enumerar tabla por tabla.
//
// Después de ese DELETE, la fila de `participants` (external_hash, role,
// team_label, group_assignment, camera_consent_given) queda huérfana si esa
// era su única campaña — se borra también, para no dejar un identificador
// pseudónimo sin ninguna sesión detrás sin necesidad. Si el mismo
// participant_id sigue teniendo otra participant_campaign (otra campaña),
// esa fila de identidad se conserva porque todavía hace falta.
import { query } from "../db.js";

export async function withdrawParticipantData(participantCampaignId, participantId) {
  await query(`DELETE FROM participant_campaign WHERE id = $1`, [participantCampaignId]);
  const remaining = await query(
    `SELECT 1 FROM participant_campaign WHERE participant_id = $1 LIMIT 1`,
    [participantId]
  );
  if (remaining.rows.length === 0) {
    await query(`DELETE FROM participants WHERE id = $1`, [participantId]);
  }
}
