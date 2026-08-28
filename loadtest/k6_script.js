// ============================================================================
// Prueba de carga simulada — PAWS Campaign Platform
// Ejecutar: k6 run --env BASE_URL=http://localhost:3000 loadtest/k6_script.js
//
// IMPORTANTE:
//   - Correr SIEMPRE contra una base de datos de staging con tokens
//     sintéticos generados por scripts/seed_synthetic_tokens.ts, nunca
//     contra la base de datos del piloto real.
//   - Los tokens usados aquí no corresponden a participantes reales.
// ============================================================================
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const openErrors = new Counter("open_errors");
const clickErrors = new Counter("click_errors");
const submitErrors = new Counter("submit_errors");
const dashboardLatency = new Trend("dashboard_push_latency_ms");

// Generado previamente por scripts/seed_synthetic_tokens.ts (200 tokens de prueba)
// Sustituir por la ruta real del archivo de tokens sintéticos.
const TOKENS = JSON.parse(open("./synthetic_tokens.json"));

export const options = {
  scenarios: {
    // Simula el pico real: 200 participantes reciben el estímulo casi
    // simultáneamente y actúan en una ventana de 5-10 minutos.
    burst_apertura: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 200 },  // rampa: todos entran al laboratorio y abren el enlace
        { duration: "5m", target: 200 },   // sostenido: interacción durante la sesión
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<300"],   // RNF de latencia de la plataforma de campañas (no confundir con latencia de inferencia ML, que es un sistema distinto)
    http_req_failed: ["rate<0.01"],
    open_errors: ["count<5"],
    click_errors: ["count<5"],
    submit_errors: ["count<5"],
  },
};

export default function () {
  const token = TOKENS[Math.floor(Math.random() * TOKENS.length)];

  // 1) Apertura del enlace (evento 'abierto')
  const openRes = http.get(`${BASE_URL}/t/${token}`);
  check(openRes, { "abrir: status 200": (r) => r.status === 200 }) || openErrors.add(1);
  sleep(Math.random() * 3 + 1); // tiempo de lectura simulado

  // 2) Clic en el botón de acción (evento 'clic') — ~40% de los VUs simulan caer
  if (Math.random() < 0.4) {
    const clickRes = http.get(`${BASE_URL}/t/${token}/click`);
    check(clickRes, { "clic: status 200": (r) => r.status === 200 }) || clickErrors.add(1);
    sleep(Math.random() * 5 + 2);

    // 3) Intento de envío del formulario — SOLO el evento, sin payload de credenciales
    const submitRes = http.post(`${BASE_URL}/t/${token}/submit`, JSON.stringify({}), {
      headers: { "Content-Type": "application/json" },
    });
    check(submitRes, { "envio: status 200": (r) => r.status === 200 }) || submitErrors.add(1);
  }
}
