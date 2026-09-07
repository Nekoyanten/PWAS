// Motor de decisión con umbral de riesgo (TG §8.2.5, Tabla 1 §8.2.1 fila 5),
// MODO SOMBRA (migración 007): calcula un puntaje de riesgo [0,1] con el
// modelo temporal (TCN + Transformer + fusión por atención, entrenado en
// ml/src/, exportado a `apps/api/models/jolting_risk_model.onnx`) sobre la
// captura conductual real de ESTE participante en ESTE mensaje, y lo guarda
// junto con la decisión que HABRÍA tomado un gate por riesgo -- sin tocar la
// lógica que hoy decide si se muestra la intervención (`joltingEligible` en
// tracking.js sigue usando `jolting_roll`, migración 006).
//
// Por qué en modo sombra: el modelo se entrenó con etiquetas 100% SINTÉTICAS
// (0 encuestas reales al momento de escribir esto -- ver
// docs/2026-09-06_pipeline-ml-offline.md). Dejar que decida a quién se le
// muestra de verdad la intervención condicionaría el experimento real a un
// clasificador sin validar; el puntaje se calcula y se guarda para análisis
// (y para poder activar el gate real más adelante, cuando haya etiquetas
// reales) sin ese riesgo.
//
// Por qué esto vive en Node y no llama al pipeline de Python: el riesgo se
// necesita en el momento del clic del participante (GET
// /:token/d/:deliveryId/go), un endpoint HTTP síncrono de este servidor --
// levantar un proceso Python (o un servicio aparte) por cada clic habría sido
// más lento y más frágil que cargar el mismo .onnx ya exportado con
// onnxruntime-node, la misma librería que correría en el navegador
// (onnxruntime-web) si algún día se decide mover la inferencia al cliente.
// Ese es también el motivo de por qué las funciones de preprocesamiento de
// abajo son un PUERTO deliberado y comentado de ml/src/preprocess.py y
// ml/src/features.py -- no una reinterpretación libre: deben producir
// exactamente los mismos números que el pipeline de Python para el mismo
// input, o el modelo (entrenado con la salida de Python) recibiría una
// distribución distinta a la que aprendió. La paridad se verifica con un
// fixture generado por el propio Python (ver
// ml/scripts/gen_risk_fixture.py y tests/unit/riskScore.test.js).
//
// El cálculo NUNCA bloquea ni retrasa la respuesta al participante: se llama
// sin `await` desde tracking.js justo después de responder la página, y
// cualquier error (sin captura conductual todavía, modelo no disponible,
// onnxruntime-node no instalado) se guarda en `risk_score_error` en vez de
// propagarse.

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL_PATH = path.join(__dirname, "..", "..", "models", "jolting_risk_model.onnx");
export const MODEL_PATH = process.env.RISK_MODEL_PATH || DEFAULT_MODEL_PATH;

// Deben coincidir EXACTAMENTE con ml/src/dataset.py (build_sequences) y
// ml/src/preprocess.py -- son los valores con los que se entrenó y exportó
// el modelo. Cambiarlos aquí sin reentrenar el modelo produciría un puntaje
// sin sentido (el modelo espera secuencias de esta forma/escala concretas).
export const MAX_MOUSE_LEN = 64;
export const MAX_KEY_LEN = 32;
export const RESAMPLE_HZ = 25.0;
export const SMOOTH_WINDOW = 5;

// ---------------------------------------------------------------------------
// Puerto de ml/src/preprocess.py
// ---------------------------------------------------------------------------

// Puerto de preprocess.resample_uniform: interpola (t,x,y) a una rejilla de
// tiempo pareja a `hz` muestras/segundo. <2 puntos o duración cero -> se
// devuelve tal cual (nada que interpolar), igual que en Python.
export function resampleUniform(t, x, y, hz = RESAMPLE_HZ) {
  const n = t.length;
  if (n < 2 || t[n - 1] <= t[0]) {
    return { t: t.slice(), x: x.slice(), y: y.slice() };
  }
  const stepMs = 1000.0 / hz;
  const start = t[0];
  // Igual que np.arange(start, stop, step): `stop` es EXCLUSIVO y el número
  // de puntos se calcula como ceil((stop-start)/step), no por acumulación
  // repetida (`v += stepMs` en un bucle acumularía error de punto flotante
  // y además incluiría o excluiría el borde de forma distinta a numpy).
  const stop = t[n - 1] + stepMs / 2;
  const count = Math.max(0, Math.ceil((stop - start) / stepMs));
  let tGrid = [];
  for (let i = 0; i < count; i++) tGrid.push(start + i * stepMs);
  if (tGrid.length < 2) {
    tGrid = [t[0], t[n - 1]];
  }
  const xr = tGrid.map((tv) => _linInterp(tv, t, x));
  const yr = tGrid.map((tv) => _linInterp(tv, t, y));
  return { t: tGrid, x: xr, y: yr };
}

// Interpolación lineal equivalente a np.interp: fuera de rango se recorta a
// los extremos (no extrapola), igual que numpy.
function _linInterp(tv, t, v) {
  const n = t.length;
  if (tv <= t[0]) return v[0];
  if (tv >= t[n - 1]) return v[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= tv) lo = mid;
    else hi = mid;
  }
  const t0 = t[lo], t1 = t[hi], v0 = v[lo], v1 = v[hi];
  if (t1 === t0) return v0;
  return v0 + ((tv - t0) / (t1 - t0)) * (v1 - v0);
}

// Puerto de preprocess.moving_average: promedio móvil centrado, bordes
// rellenados por repetición (equivalente a np.pad(..., mode="edge") +
// np.convolve(..., mode="valid")). Ventana par se ajusta a impar (+1).
export function movingAverage(arr, window = SMOOTH_WINDOW) {
  const n = arr.length;
  if (n === 0) return arr.slice();
  if (window <= 1 || n < 2) return arr.slice();
  let w = window;
  if (w % 2 === 0) w += 1;
  const half = (w - 1) / 2;
  const padded = new Array(n + 2 * half);
  for (let i = 0; i < half; i++) padded[i] = arr[0];
  for (let i = 0; i < n; i++) padded[half + i] = arr[i];
  for (let i = 0; i < half; i++) padded[half + n + i] = arr[n - 1];
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < w; k++) sum += padded[i + k];
    out[i] = sum / w;
  }
  return out;
}

// Puerto de preprocess.normalize_by_viewport: x,y a [0,1] relativo al
// viewport de esa sesión. Sin viewport (0/null) -> pasa intacto, igual que
// en Python (dividir por 0 no aportaría nada real).
export function normalizeByViewport(x, y, viewportW, viewportH) {
  if (!viewportW || !viewportH) return { x: x.slice(), y: y.slice() };
  return { x: x.map((v) => v / viewportW), y: y.map((v) => v / viewportH) };
}

// Puerto de preprocess.preprocess_mouse_samples: normalización por viewport
// -> resampleo -> suavizado, sobre eventos crudos con x,y (mousemove Y click,
// igual filtro que features.py). Devuelve pseudo-eventos {t_ms,x,y,event_type}
// -- misma forma que consumen mouseSequence()/features.py en Python.
export function preprocessMouseSamples(events, viewportW, viewportH, hz = RESAMPLE_HZ, window = SMOOTH_WINDOW) {
  const pts = events.filter((e) => e.x != null && e.y != null).map((e) => [e.t_ms, e.x, e.y]);
  if (pts.length < 2) {
    return pts.map(([t, x, y]) => ({ t_ms: t, x, y, event_type: "mousemove" }));
  }
  const t = pts.map((p) => p[0]);
  const xRaw = pts.map((p) => p[1]);
  const yRaw = pts.map((p) => p[2]);
  const { x: xn, y: yn } = normalizeByViewport(xRaw, yRaw, viewportW, viewportH);
  const { t: tr, x: xr, y: yr } = resampleUniform(t, xn, yn, hz);
  const xs = movingAverage(xr, window);
  const ys = movingAverage(yr, window);
  const out = [];
  for (let i = 0; i < tr.length; i++) out.push({ t_ms: tr[i], x: xs[i], y: ys[i], event_type: "mousemove" });
  return out;
}

// ---------------------------------------------------------------------------
// Puerto de ml/src/features.py (solo las dos secuencias que consume el
// modelo temporal -- las features agregadas AUC/SE/MD/latencias no hacen
// falta aquí, esas alimentan a los baselines tabulares, no al modelo ONNX).
// ---------------------------------------------------------------------------

// Puerto de features.mouse_sequence: deltas (dt,dx,dy) entre muestras
// consecutivas YA preprocesadas.
export function mouseSequence(samples) {
  const pts = samples.filter((s) => s.x != null && s.y != null).map((s) => [s.t_ms, s.x, s.y]);
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const [t0, x0, y0] = pts[i - 1];
    const [t1, x1, y1] = pts[i];
    out.push([t1 - t0, x1 - x0, y1 - y0]);
  }
  return out;
}

// Puerto de features.keystroke_sequence: (dwell_ms, flight_ms) por tecla
// soltada, emparejando keydown/keyup por key_code con una pila (tolera dos
// teclas presionadas a la vez sin cruzarse) -- idéntico al de Python.
export function keystrokeSequence(events) {
  const evs = events.filter((e) => e.event_type === "keydown" || e.event_type === "keyup");
  const openByKey = new Map();
  let lastKeyupT = null;
  let pendingFlight = 0.0;
  const out = [];
  for (const e of evs) {
    const code = e.key_code || "?";
    if (e.event_type === "keydown") {
      if (lastKeyupT != null) pendingFlight = Math.max(0.0, e.t_ms - lastKeyupT);
      if (!openByKey.has(code)) openByKey.set(code, []);
      openByKey.get(code).push(e.t_ms);
    } else {
      const stack = openByKey.get(code);
      if (stack && stack.length) {
        const downT = stack.pop();
        const dwell = Math.max(0.0, e.t_ms - downT);
        out.push([dwell, pendingFlight]);
      }
      lastKeyupT = e.t_ms;
    }
  }
  return out;
}

// Puerto de dataset._pad: rellena/trunca `seq` a `maxLen` filas de `width`
// columnas, con una máscara de qué posiciones son datos reales (true) vs
// relleno (false) -- exactamente igual que build_sequences() en Python.
export function padSequence(seq, maxLen, width) {
  const arr = new Float32Array(maxLen * width);
  const mask = new Array(maxLen).fill(false);
  const n = Math.min(seq.length, maxLen);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < width; j++) arr[i * width + j] = seq[i][j];
    mask[i] = true;
  }
  return { arr, mask };
}

// ---------------------------------------------------------------------------
// Carga perezosa (una sola vez) de onnxruntime-node + la sesión del modelo.
// Cualquier fallo (paquete no instalado, archivo no encontrado, plataforma
// sin binario prebuilt) deja `sessionPromise` resuelto a null -- el llamador
// trata "no hay modelo" igual que "no hay captura conductual todavía": se
// guarda el motivo en risk_score_error, nunca se lanza al participante.
// ---------------------------------------------------------------------------

let sessionPromise = null;
let cachedModelHash = null;

function modelHash() {
  if (cachedModelHash !== null) return cachedModelHash;
  try {
    cachedModelHash = createHash("sha256").update(readFileSync(MODEL_PATH)).digest("hex");
  } catch {
    cachedModelHash = null;
  }
  return cachedModelHash;
}

async function getSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    if (!existsSync(MODEL_PATH)) {
      return { session: null, error: `Modelo ONNX no encontrado en ${MODEL_PATH}` };
    }
    let ort;
    try {
      ort = await import("onnxruntime-node");
    } catch (err) {
      return { session: null, error: `onnxruntime-node no disponible: ${err.message}` };
    }
    try {
      const session = await ort.InferenceSession.create(MODEL_PATH, { executionProviders: ["cpu"] });
      return { session, error: null, ort };
    } catch (err) {
      return { session: null, error: `No se pudo cargar el modelo ONNX: ${err.message}` };
    }
  })();
  return sessionPromise;
}

const sigmoid = (logit) => 1.0 / (1.0 + Math.exp(-logit));

// Corre el modelo temporal sobre secuencias YA paddeadas/enmascaradas y
// devuelve {logit, score} (score = sigmoid(logit) en [0,1]), o null si el
// modelo no está disponible.
export async function runInference(mouseArr, mouseMask, keyArr, keyMask) {
  const { session, ort, error } = await getSession();
  if (!session) return { error };
  const mouseMaskU8 = Uint8Array.from(mouseMask, (v) => (v ? 1 : 0));
  const keyMaskU8 = Uint8Array.from(keyMask, (v) => (v ? 1 : 0));
  const feeds = {
    mouse_x: new ort.Tensor("float32", mouseArr, [1, MAX_MOUSE_LEN, 3]),
    mouse_mask: new ort.Tensor("bool", mouseMaskU8, [1, MAX_MOUSE_LEN]),
    key_x: new ort.Tensor("float32", keyArr, [1, MAX_KEY_LEN, 2]),
    key_mask: new ort.Tensor("bool", keyMaskU8, [1, MAX_KEY_LEN]),
  };
  const results = await session.run(feeds);
  const logit = results.risk_logit.data[0];
  return { logit, score: sigmoid(logit), error: null };
}

// Encadena preprocesamiento + secuencias + padding + inferencia sobre
// eventos crudos {t_ms, event_type, x, y, key_code} de UNA sesión de
// comportamiento (ya ordenados por t_ms). Puro (sin DB) para poder probarlo
// con el fixture generado desde Python -- ver tests/unit/riskScore.test.js.
export async function scoreBehaviorEvents(events, viewportW, viewportH) {
  const preMouse = preprocessMouseSamples(events, viewportW, viewportH);
  const mSeq = mouseSequence(preMouse);
  const kSeq = keystrokeSequence(events);
  const { arr: mArr, mask: mMask } = padSequence(mSeq, MAX_MOUSE_LEN, 3);
  const { arr: kArr, mask: kMask } = padSequence(kSeq, MAX_KEY_LEN, 2);
  const out = await runInference(mArr, mMask, kArr, kMask);
  return { ...out, nMousePoints: preMouse.length, nKeystrokes: kSeq.length };
}

// ---------------------------------------------------------------------------
// Integración con Postgres: calcula el puntaje para UN delivery concreto
// (a partir de su behavior_session de fase 'message', si existe) y lo
// persiste. Se llama SIN await desde tracking.js -- ver comentario de
// cabecera. Nunca lanza: cualquier error queda en risk_score_error.
// ---------------------------------------------------------------------------

export async function scoreAndStoreDeliveryRisk(deliveryId) {
  try {
    const sessRes = await query(
      `SELECT id, viewport_w, viewport_h FROM behavior_sessions
       WHERE delivery_id = $1 AND phase = 'message'
       ORDER BY started_at DESC LIMIT 1`,
      [deliveryId]
    );
    const session = sessRes.rows[0];
    if (!session) {
      await _storeError(deliveryId, "Sin sesión de captura conductual (fase 'message') para este delivery todavía");
      return;
    }
    const evRes = await query(
      `SELECT t_ms, event_type, x, y, key_code FROM behavior_events
       WHERE behavior_session_id = $1 ORDER BY t_ms ASC`,
      [session.id]
    );
    if (evRes.rows.length === 0) {
      await _storeError(deliveryId, "Sesión de captura conductual sin muestras todavía");
      return;
    }

    const result = await scoreBehaviorEvents(evRes.rows, session.viewport_w, session.viewport_h);
    if (result.error || typeof result.score !== "number") {
      await _storeError(deliveryId, result.error || "Fallo desconocido calculando el puntaje de riesgo");
      return;
    }

    const campRes = await query(
      `SELECT c.risk_threshold FROM deliveries d
       JOIN participant_campaign pc ON pc.id = d.participant_campaign_id
       JOIN campaigns c ON c.id = pc.campaign_id
       WHERE d.id = $1`,
      [deliveryId]
    );
    const threshold = Number(campRes.rows[0]?.risk_threshold ?? 0.5);
    const wouldTrigger = result.score >= threshold;

    await query(
      `UPDATE deliveries
       SET risk_score = $1, risk_would_trigger = $2, risk_scored_at = now(),
           risk_model_version = $3, risk_score_error = NULL
       WHERE id = $4`,
      [result.score, wouldTrigger, modelHash(), deliveryId]
    );
  } catch (err) {
    await _storeError(deliveryId, `Error inesperado: ${err.message}`).catch(() => {});
  }
}

async function _storeError(deliveryId, message) {
  await query(
    `UPDATE deliveries SET risk_score_error = $1, risk_scored_at = now() WHERE id = $2`,
    [message.slice(0, 500), deliveryId]
  );
}
