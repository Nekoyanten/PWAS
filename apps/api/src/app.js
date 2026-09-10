import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";
// DEBE importarse antes de registrar cualquier ruta (parchea Router/Route a
// nivel de prototipo -- ver migración 011 y docs/2026-09-10_fix-rls-app-
// service-y-crash-async.md). Sin esto, un error dentro de un handler
// `async (req, res) => {...}` que ninguna ruta captura con try/catch se
// convierte en una promesa rechazada sin manejar; desde Node 15 eso tumba
// TODO el proceso (no solo la petición que falló), como pasó con
// POST /api/campaigns cuando RLS empezó a rechazar el INSERT. Con esto, ese
// mismo error cae en el middleware de errores de abajo y responde 500 sin
// afectar a nadie más.
import "express-async-errors";

import { participantsRouter } from "./routes/participants.js";
import { templatesRouter } from "./routes/templates.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { messagesRouter } from "./routes/messages.js";
import { trackingRouter } from "./routes/tracking.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { exportRouter } from "./routes/export.js";
import { interactionRouter } from "./routes/interaction.js";
import { pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: false })); // formularios del flujo del participante
  app.use(express.text({ type: ["text/csv", "text/plain"] })); // import de participantes por CSV
  if (process.env.NODE_ENV !== "test") app.use(morgan("tiny"));

  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/health", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, db: "up" });
    } catch (err) {
      res.status(503).json({ ok: false, db: "down", error: err.message });
    }
  });

  app.use("/api/participants", participantsRouter);
  app.use("/api/templates", templatesRouter);
  app.use("/api/campaigns", campaignsRouter);
  app.use("/api", messagesRouter); // /api/campaigns/:id/messages, /api/messages/:id/*
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/export", exportRouter);
  app.use("/api", interactionRouter); // /api/campaigns/:id/contacts, /board-templates, /chat-scripts; /api/templates/:id/branches
  app.use("/t", trackingRouter);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error("[error]", err);
    // 42501 = insufficient_privilege en Postgres -- el caso más probable en
    // este proyecto es una policy de RLS rechazando al rol de la app (ver
    // migración 011). Se distingue en la respuesta para que no haya que
    // adivinarlo desde un 500 genérico ni ir a buscar los logs de Render
    // cada vez.
    if (err?.code === "42501") {
      return res.status(500).json({
        error: "La base de datos rechazó la operación por permisos (RLS). Ver migración 011.",
      });
    }
    res.status(500).json({ error: "Error interno del servidor" });
  });

  return app;
}
