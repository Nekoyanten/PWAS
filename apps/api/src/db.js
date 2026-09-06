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

// `query()` de arriba usa el pool directamente: cada llamada puede tomar un
// cliente/conexión distinto, lo cual está bien para consultas sueltas pero
// es incorrecto en cuanto una operación necesita leer y luego escribir de
// forma atómica (p.ej. un advisory lock, o un "leer N filas -> decidir ->
// escribir las N" que no debe entrelazarse con otra llamada concurrente a lo
// mismo). `withTransaction` reserva UN solo cliente del pool, corre `fn`
// dentro de BEGIN/COMMIT (ROLLBACK si `fn` lanza), y siempre libera el
// cliente al final. `fn` recibe ese cliente y debe usar `client.query(...)`
// para TODAS sus consultas — mezclar con el `query()` de arriba dentro de
// una transacción rompería la garantía, porque iría a otra conexión.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
