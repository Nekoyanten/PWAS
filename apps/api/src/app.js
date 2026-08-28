import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { participantsRouter } from "./routes/participants.js";
import { templatesRouter } from "./routes/templates.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { messagesRouter } from "./routes/messages.js";
import { trackingRouter } from "./routes/tracking.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { exportRouter } from "./routes/export.js";
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
  app.use("/t", trackingRouter);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error("[error]", err);
    res.status(500).json({ error: "Error interno del servidor" });
  });

  return app;
}
