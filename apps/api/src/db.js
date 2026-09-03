import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

// Hosts administrados como Supabase/Render exigen TLS y no aceptan una
// conexión en texto plano; Postgres local (desarrollo/tests) normalmente no
// tiene TLS configurado y rompería si lo forzamos. PGSSL permite forzar el
// valor explícitamente; si no se define, se detecta a partir del host en
// DATABASE_URL para no romper el flujo local/tests existente.
const databaseUrl = process.env.DATABASE_URL || "";
const useSSL =
  process.env.PGSSL === "require"
    ? true
    : process.env.PGSSL === "disable"
    ? false
    : /\.supabase\.co|\.render\.com/.test(databaseUrl);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[db] error inesperado en el pool de conexiones", err);
});

export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const ms = Date.now() - start;
  if (ms > 200) {
    // eslint-disable-next-line no-console
    console.warn(`[db] consulta lenta (${ms}ms): ${text.slice(0, 120)}`);
  }
  return res;
}
