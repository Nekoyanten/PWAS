import { Router } from "express";
import { query } from "../db.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

export const exportRouter = Router();

function toCsv(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(","));
  return lines.join("\n");
}

exportRouter.get("/by-role-vector.:format", requireAdmin, async (req, res) => {
  const result = await query(`SELECT * FROM v_metrics_by_role_vector ORDER BY role, vector`);
  if (req.params.format === "csv") {
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", "attachment; filename=metrics_by_role_vector.csv");
    return res.send(toCsv(result.rows));
  }
  res.json(result.rows);
});

exportRouter.get("/by-team.:format", requireAdmin, async (req, res) => {
  const result = await query(`SELECT * FROM v_falls_by_team ORDER BY team_label, participantes_caidos DESC`);
  if (req.params.format === "csv") {
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", "attachment; filename=falls_by_team.csv");
    return res.send(toCsv(result.rows));
  }
  res.json(result.rows);
});
