// El parser CSV de /api/participants/import-csv usaba line.split(","), que
// corta un campo entrecomillado que contiene una coma (p.ej. un team_label
// como "Sistemas, turno tarde") en el lugar equivocado. Esta prueba fija el
// comportamiento correcto: los campos entre comillas se respetan, incluida
// una coma dentro de ellos y una comilla escapada como "".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db.js";

process.env.NODE_ENV = "test";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "test_key_local_only";

let server, baseUrl;
const key = process.env.ADMIN_API_KEY;

before(async () => { server = createApp().listen(0); baseUrl = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

test("import-csv respeta comas dentro de campos entrecomillados", async () => {
  const h1 = `csv_${Date.now()}_a`;
  const h2 = `csv_${Date.now()}_b`;
  const csv =
    `external_hash,role,team_label,group_assignment\n` +
    `${h1},estudiante,"Sistemas, turno tarde",control\n` +
    `${h2},estudiante,"Dicho ""oficial""",experimental\n`;

  const res = await fetch(`${baseUrl}/api/participants/import-csv`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "text/csv" },
    body: csv,
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.imported, 2);

  const byHash = Object.fromEntries(body.participants.map((p) => [p.external_hash, p]));
  assert.equal(byHash[h1].team_label, "Sistemas, turno tarde");
  assert.equal(byHash[h2].team_label, 'Dicho "oficial"');
});
