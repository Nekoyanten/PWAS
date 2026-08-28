import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
