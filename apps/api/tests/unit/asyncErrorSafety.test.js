// Regresión del incidente de producción del 2026-09-10: un error dentro de
// un handler `async (req, res) => {...}` que ninguna ruta captura con
// try/catch (la mayoría de las rutas de este proyecto no lo hacen) se
// convertía en una promesa rechazada sin manejar y tumbaba TODO el proceso
// de Node (no solo la petición que falló) -- exactamente lo que pasó con
// POST /api/campaigns cuando RLS empezó a rechazar el INSERT (ver migración
// 011 y docs/2026-09-10_fix-rls-app-service-y-crash-async.md). El fix es
// `import "express-async-errors"` en app.js, ANTES de registrar cualquier
// ruta -- esta prueba no vuelve a montar toda la app (no depende de
// Postgres): monta una app mínima con una ruta que lanza a propósito, y
// verifica que el error termina en el middleware de errores (respuesta
// controlada) en vez de escapar como una excepción del proceso.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
// Efecto secundario: parchea Router/Route a nivel de prototipo. Real en
// producción se importa desde app.js; acá se importa directo para no
// depender de crear un servidor completo (Postgres, etc.) solo para esto.
import "express-async-errors";

test("un error async sin try/catch en una ruta no escapa como excepción del proceso: cae en el error handler", async () => {
  const app = express();
  app.get("/explota", async () => {
    throw new Error("fallo simulado, ej. RLS 42501");
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: "capturado", message: err.message });
  });

  const server = app.listen(0);
  try {
    const base = `http://localhost:${server.address().port}`;
    const res = await fetch(`${base}/explota`);
    assert.equal(res.status, 500, "el error debe traducirse en una respuesta controlada, no en una conexión cortada");
    const body = await res.json();
    assert.equal(body.error, "capturado");
    assert.match(body.message, /fallo simulado/);
  } finally {
    server.close();
  }
});
