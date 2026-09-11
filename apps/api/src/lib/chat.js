// Hilo de chat persistente por participante (migración 010). Un hilo se
// "instancia" una sola vez, la primera vez que el participante abre la vista
// de chat: si la campaña tiene un guion (chat_script_templates), sus pasos
// se copian en orden a chat_messages —
//   'scripted' -> se copia tal cual (un compañero ficticio ya dijo esto).
//   'attack'   -> se crea un message+delivery real a partir del template_id
//                 (mismo mecanismo que un envío de correo, ver
//                 lib/messageFactory.js) y se enlaza por delivery_id: el
//                 contenido del ataque vive en messages/deliveries, no acá,
//                 así toda la telemetría (eventos, jolting, riesgo) sigue
//                 funcionando sin cambios para un ataque entregado por chat.
// Si la campaña no tiene guion, el hilo se crea vacío (el participante puede
// igual escribir; solo que nadie le va a "contestar" a menos que el admin
// use el árbol de respuestas sobre un ataque que sí llegue por otro medio).
import { query, withTransaction } from "../db.js";
import { insertMessage, createDeliveryForParticipant } from "./messageFactory.js";

export async function getOrCreateThread(pc) {
  const existing = await query(`SELECT * FROM chat_threads WHERE participant_campaign_id = $1`, [pc.id]);
  if (existing.rows.length > 0) return { thread: existing.rows[0], created: false };

  // Carrera posible si dos requests casi simultáneas del mismo participante
  // llegan a la vez (dos pestañas) — el UNIQUE en participant_campaign_id
  // + ON CONFLICT hace que solo una gane la creación; la otra simplemente
  // relee la fila ganadora.
  return withTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO chat_threads (participant_campaign_id) VALUES ($1)
       ON CONFLICT (participant_campaign_id) DO NOTHING RETURNING *`,
      [pc.id]
    );
    if (ins.rows[0]) {
      await instantiateScript(client, pc, ins.rows[0]);
      return { thread: ins.rows[0], created: true };
    }
    const r = await client.query(`SELECT * FROM chat_threads WHERE participant_campaign_id = $1`, [pc.id]);
    return { thread: r.rows[0], created: false };
  });
}

async function instantiateScript(client, pc, thread) {
  const scriptRow = await client.query(
    `SELECT * FROM chat_script_templates WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [pc.campaign_id]
  );
  if (scriptRow.rows.length === 0) return;
  const campaign = await client.query(`SELECT seed FROM campaigns WHERE id = $1`, [pc.campaign_id]);
  const campaignSeed = campaign.rows[0]?.seed;
  const steps = Array.isArray(scriptRow.rows[0].script) ? scriptRow.rows[0].script : [];

  let position = 0;
  for (const step of steps) {
    if (step.type === "scripted") {
      await client.query(
        `INSERT INTO chat_messages (chat_thread_id, sender_contact_id, kind, body, position)
         VALUES ($1, $2, 'scripted', $3, $4)`,
        [thread.id, step.sender_contact_id ?? null, step.body, position++]
      );
    } else if (step.type === "attack") {
      const tpl = await client.query(`SELECT * FROM templates WHERE id = $1`, [step.template_id]);
      if (tpl.rows.length === 0) continue; // plantilla borrada después de guardar el guion: se salta, no rompe el resto
      const t = tpl.rows[0];
      const msg = await client.query(
        `INSERT INTO messages
           (campaign_id, template_id, kind, is_attack, vector, sender_label, subject, body, cta_label, landing_kind, landing_config)
         VALUES ($1,$2,'chat',$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
        [
          pc.campaign_id, t.id, t.is_attack, t.is_attack ? t.vector : null, t.sender_label,
          t.subject_or_headline, t.message_body, t.is_attack ? t.cta_label : null,
          t.is_attack ? t.landing_kind : null, JSON.stringify(t.is_attack ? t.landing_config : {}),
        ]
      );
      const d = await client.query(
        `INSERT INTO deliveries (message_id, participant_campaign_id, jolting_roll) VALUES ($1,$2,TRUE) RETURNING *`,
        [msg.rows[0].id, pc.id]
      );
      await client.query(
        `INSERT INTO events (participant_campaign_id, delivery_id, event_type) VALUES ($1,$2,'entregado')`,
        [pc.id, d.rows[0].id]
      );
      await client.query(
        `INSERT INTO chat_messages (chat_thread_id, sender_contact_id, kind, delivery_id, position)
         VALUES ($1, $2, 'attack', $3, $4)`,
        [thread.id, step.sender_contact_id ?? null, d.rows[0].id, position++]
      );
    }
  }
  // Nota: el sorteo de jolting para un ataque de chat se fija en TRUE arriba
  // (no se llama a rollJolting/createDeliveryForParticipant de
  // messageFactory) porque en este punto el guion se está clonando dentro de
  // una transacción abierta por getOrCreateThread con `client`, y
  // createDeliveryForParticipant usa el pool general (`query`), no ese
  // client — mezclar los dos rompería la transacción. Como la probabilidad
  // por defecto de campañas existentes ya es 1.000 (migración 006), fijarlo
  // en TRUE reproduce exactamente ese comportamiento por defecto; si se
  // necesita sortear jolting también para ataques de chat con probabilidad
  // distinta de 1, es una mejora aparte (ver docs).
}

// Antes esta consulta NO traía el árbol de respuestas (message_branches) de
// un ataque de chat, así que la única forma de contestarlo era hacer clic en
// "Abrir" y salir del chat hacia la tarjeta de mensaje de siempre (que sí
// arma sus propios botones de respuesta rápida, ver renderMessage en
// decoy.js) -- el chat en sí nunca tenía nada con qué "responder" un
// ataque, lo que lo hacía sentir roto/inerte aunque el mecanismo de branching
// funcionara bien del lado del correo. Se corrige trayendo las ramas
// disponibles por cada mensaje de tipo 'attack', para que la burbuja del
// chat pueda ofrecer los mismos botones sin salir del hilo.
export async function loadThreadMessages(threadId) {
  const r = await query(
    `SELECT cm.id, cm.kind, cm.body, cm.position, cm.created_at,
            fc.id AS sender_id, fc.display_name AS sender_name, fc.avatar_color AS sender_color,
            d.id AS delivery_id, m.subject AS attack_subject, m.cta_label AS attack_cta, m.is_attack,
            m.id AS attack_message_id, m.template_id AS attack_template_id, m.parent_message_id
     FROM chat_messages cm
     LEFT JOIN fictitious_contacts fc ON fc.id = cm.sender_contact_id
     LEFT JOIN deliveries d ON d.id = cm.delivery_id
     LEFT JOIN messages m ON m.id = d.message_id
     WHERE cm.chat_thread_id = $1
     ORDER BY cm.position, cm.created_at`,
    [threadId]
  );
  const rows = r.rows;

  // Un solo IN en vez de una consulta de ramas por cada mensaje de ataque
  // (evita N+1 -- un hilo de chat típico tiene pocos ataques, pero no hay
  // razón para no traerlas todas de un tiro).
  const templateIds = [...new Set(rows.filter((m) => m.kind === "attack" && m.attack_template_id).map((m) => m.attack_template_id))];
  const branchesByTemplate = new Map();
  if (templateIds.length) {
    const br = await query(
      `SELECT from_template_id, action_key, action_label FROM message_branches WHERE from_template_id = ANY($1::uuid[]) ORDER BY created_at`,
      [templateIds]
    );
    for (const b of br.rows) {
      if (!branchesByTemplate.has(b.from_template_id)) branchesByTemplate.set(b.from_template_id, []);
      branchesByTemplate.get(b.from_template_id).push({ action_key: b.action_key, action_label: b.action_label });
    }
  }
  // Un ataque ya contestado (existe otro message en el mismo hilo cuyo
  // parent_message_id apunta a este) no debe seguir ofreciendo los mismos
  // botones -- si no, el participante podría "responder" el mismo ataque
  // varias veces y generar ataques de seguimiento duplicados en el hilo.
  const answeredParents = new Set(rows.filter((m) => m.parent_message_id).map((m) => m.parent_message_id));

  return rows.map(({ parent_message_id, ...m }) => ({
    ...m,
    branches: m.kind === "attack" && m.attack_template_id && !answeredParents.has(m.attack_message_id)
      ? (branchesByTemplate.get(m.attack_template_id) || [])
      : [],
  }));
}

export async function appendReply(threadId, body) {
  const posRow = await query(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM chat_messages WHERE chat_thread_id = $1`, [threadId]);
  const r = await query(
    `INSERT INTO chat_messages (chat_thread_id, kind, body, position) VALUES ($1, 'reply', $2, $3) RETURNING *`,
    [threadId, body, posRow.rows[0].next]
  );
  return r.rows[0];
}

// Inyecta un ataque ya creado (message+delivery, típicamente resultado de
// seguir una rama del árbol de respuestas) al final del hilo de chat de este
// participante, si tiene uno. No falla si el participante todavía no tiene
// hilo (queda simplemente sin insertar; el mensaje sigue existiendo como
// delivery normal).
export async function appendAttackToThread(pcId, deliveryId, senderContactId) {
  const thread = await query(`SELECT id FROM chat_threads WHERE participant_campaign_id = $1`, [pcId]);
  if (thread.rows.length === 0) return null;
  const posRow = await query(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM chat_messages WHERE chat_thread_id = $1`, [thread.rows[0].id]);
  const r = await query(
    `INSERT INTO chat_messages (chat_thread_id, sender_contact_id, kind, delivery_id, position)
     VALUES ($1, $2, 'attack', $3, $4) RETURNING *`,
    [thread.rows[0].id, senderContactId ?? null, deliveryId, posRow.rows[0].next]
  );
  return r.rows[0];
}

export { insertMessage, createDeliveryForParticipant };
