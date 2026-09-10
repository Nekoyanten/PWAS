// Tableros reales del participante (migración 010). Antes: un único tablero
// de ejemplo, persistido solo en localStorage del navegador (invisible para
// el equipo). Ahora: el participante puede crear varios, cada uno con 3
// columnas estándar (Por hacer / En curso / Hecho) y tareas con un
// responsable elegido de fictitious_contacts (nunca texto libre — ver
// migración 010 y docs).
import { query, withTransaction } from "../db.js";

const DEFAULT_COLUMNS = ["Por hacer", "En curso", "Hecho"];

export async function loadBoards(participantCampaignId) {
  const boards = await query(
    `SELECT * FROM boards WHERE participant_campaign_id = $1 ORDER BY created_at`,
    [participantCampaignId]
  );
  if (boards.rows.length === 0) return [];

  const boardIds = boards.rows.map((b) => b.id);
  const columns = await query(
    `SELECT * FROM board_columns WHERE board_id = ANY($1::uuid[]) ORDER BY position, created_at`,
    [boardIds]
  );
  const columnIds = columns.rows.map((c) => c.id);
  const tasks = columnIds.length
    ? await query(
        `SELECT t.*, fc.display_name AS responsible_name, fc.avatar_color AS responsible_color
         FROM board_tasks t LEFT JOIN fictitious_contacts fc ON fc.id = t.responsible_contact_id
         WHERE t.column_id = ANY($1::uuid[]) ORDER BY t.position, t.created_at`,
        [columnIds]
      )
    : { rows: [] };

  const tasksByColumn = new Map();
  for (const t of tasks.rows) {
    if (!tasksByColumn.has(t.column_id)) tasksByColumn.set(t.column_id, []);
    tasksByColumn.get(t.column_id).push(t);
  }
  const columnsByBoard = new Map();
  for (const c of columns.rows) {
    if (!columnsByBoard.has(c.board_id)) columnsByBoard.set(c.board_id, []);
    columnsByBoard.get(c.board_id).push({ ...c, tasks: tasksByColumn.get(c.id) || [] });
  }
  return boards.rows.map((b) => ({ ...b, columns: columnsByBoard.get(b.id) || [] }));
}

// Crea un tablero nuevo. Si `templateId` viene dado, clona sus columnas y
// tareas semilla (board_templates.seed); si no, arranca con las 3 columnas
// estándar y sin tareas.
export async function createBoard(participantCampaignId, { name, templateId }) {
  return withTransaction(async (client) => {
    const board = await client.query(
      `INSERT INTO boards (participant_campaign_id, name) VALUES ($1, $2) RETURNING *`,
      [participantCampaignId, name]
    );
    const boardId = board.rows[0].id;

    let seedColumns = DEFAULT_COLUMNS.map((name) => ({ name, tasks: [] }));
    if (templateId) {
      const tpl = await client.query(`SELECT seed FROM board_templates WHERE id = $1`, [templateId]);
      if (tpl.rows.length > 0 && Array.isArray(tpl.rows[0].seed) && tpl.rows[0].seed.length > 0) {
        seedColumns = tpl.rows[0].seed;
      }
    }

    let colPos = 0;
    for (const col of seedColumns) {
      const c = await client.query(
        `INSERT INTO board_columns (board_id, name, position) VALUES ($1, $2, $3) RETURNING *`,
        [boardId, col.name, colPos++]
      );
      let taskPos = 0;
      for (const t of col.tasks || []) {
        await client.query(
          `INSERT INTO board_tasks (column_id, title, description, responsible_contact_id, position)
           VALUES ($1, $2, $3, $4, $5)`,
          [c.rows[0].id, t.title, t.description ?? null, t.responsible_contact_id ?? null, taskPos++]
        );
      }
    }
    return board.rows[0];
  });
}

// Verifica que el tablero pertenezca al participante antes de mutarlo — sin
// esto, un token ajeno podría adivinar un board_id y editarlo.
export async function assertBoardOwnership(boardId, participantCampaignId) {
  const r = await query(`SELECT id FROM boards WHERE id = $1 AND participant_campaign_id = $2`, [boardId, participantCampaignId]);
  return r.rows.length > 0;
}

export async function createTask(columnId, { title, description, responsible_contact_id }) {
  const posRow = await query(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM board_tasks WHERE column_id = $1`, [columnId]);
  const r = await query(
    `INSERT INTO board_tasks (column_id, title, description, responsible_contact_id, position)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [columnId, title, description ?? null, responsible_contact_id ?? null, posRow.rows[0].next]
  );
  return r.rows[0];
}

export async function updateTask(taskId, fields) {
  const r = await query(
    `UPDATE board_tasks SET
       title = COALESCE($1, title),
       description = COALESCE($2, description),
       responsible_contact_id = COALESCE($3, responsible_contact_id),
       column_id = COALESCE($4, column_id),
       position = COALESCE($5, position),
       updated_at = now()
     WHERE id = $6 RETURNING *`,
    [fields.title ?? null, fields.description ?? null, fields.responsible_contact_id ?? null, fields.column_id ?? null, fields.position ?? null, taskId]
  );
  return r.rows[0] ?? null;
}

export async function deleteTask(taskId) {
  const r = await query(`DELETE FROM board_tasks WHERE id = $1 RETURNING id`, [taskId]);
  return r.rows.length > 0;
}

// El column_id destino de un task pertenece al MISMO tablero que la tarea de
// origen — evita mover una tarea a un tablero ajeno vía id adivinado.
export async function assertColumnInBoard(columnId, boardId) {
  const r = await query(`SELECT id FROM board_columns WHERE id = $1 AND board_id = $2`, [columnId, boardId]);
  return r.rows.length > 0;
}

export async function taskBoardId(taskId) {
  const r = await query(
    `SELECT bc.board_id FROM board_tasks bt JOIN board_columns bc ON bc.id = bt.column_id WHERE bt.id = $1`,
    [taskId]
  );
  return r.rows[0]?.board_id ?? null;
}
