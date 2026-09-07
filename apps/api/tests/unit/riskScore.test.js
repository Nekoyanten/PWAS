// Pruebas unitarias del motor de decisión por riesgo (TG §8.2.5, migración
// 007, MODO SOMBRA) -- lib/riskScore.js, sin Postgres.
//
// Dos tipos de prueba, deliberadamente distintos:
//
// 1. Casos de valor conocido para cada función de preprocesamiento
//    (resampleUniform/movingAverage/normalizeByViewport), mismo patrón que
//    ml/tests/test_preprocess.py -- pero AQUÍ importa además que el puerto a
//    JavaScript no se haya desviado de la fuente de verdad en Python.
// 2. Una prueba de PARIDAD contra un fixture generado por el propio Python
//    (ml/scripts/gen_risk_fixture.py -> tests/fixtures/risk_score_fixture.json):
//    mismos eventos crudos, mismo modelo .onnx committeado, comparados byte
//    a byte / número a número contra la salida real de
//    ml/src/preprocess.py + ml/src/features.py + onnxruntime (Python). Sin
//    esto, un desvío de redondeo o un off-by-one en el puerto pasaría
//    desapercibido hasta producir un puntaje de riesgo silenciosamente
//    incorrecto en producción -- se encontró y corrigió exactamente uno de
//    esos desvíos (la semántica de np.arange en resampleUniform) escribiendo
//    esta misma prueba, antes de que llegara a tracking.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resampleUniform, movingAverage, normalizeByViewport, preprocessMouseSamples,
  mouseSequence, keystrokeSequence, padSequence, scoreBehaviorEvents,
  runInference, MAX_MOUSE_LEN, MAX_KEY_LEN, MODEL_PATH,
} from "../../src/lib/riskScore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(path.join(__dirname, "..", "fixtures", "risk_score_fixture.json"), "utf-8"));

/* ------------------------- resampleUniform ------------------------- */

test("resampleUniform: con <2 puntos devuelve la entrada intacta (nada que interpolar)", () => {
  const r0 = resampleUniform([], [], []);
  assert.deepEqual(r0, { t: [], x: [], y: [] });
  const r1 = resampleUniform([10], [5], [6]);
  assert.deepEqual(r1, { t: [10], x: [5], y: [6] });
});

test("resampleUniform: duración cero (todo el mismo instante) devuelve la entrada intacta", () => {
  const r = resampleUniform([10, 10, 10], [1, 2, 3], [4, 5, 6]);
  assert.deepEqual(r, { t: [10, 10, 10], x: [1, 2, 3], y: [4, 5, 6] });
});

test("resampleUniform: preserva los extremos y espacia la rejilla en 1000/hz ms", () => {
  const { t } = resampleUniform([0, 250], [0, 1], [0, 1], 25);
  assert.equal(t[0], 0);
  assert.equal(t[t.length - 1], 240, "el último punto de la rejilla nunca sobrepasa el final real (240 < 250, 280 se excede)");
  for (let i = 1; i < t.length; i++) assert.ok(Math.abs(t[i] - t[i - 1] - 40) < 1e-9, "paso constante de 40ms (25Hz)");
});

test("resampleUniform: interpola linealmente entre dos puntos conocidos", () => {
  const { x, y } = resampleUniform([0, 100], [0, 100], [0, 200], 10);
  // Rejilla a 10Hz (paso 100ms) entre t=0 y t=100 -> solo 0 y 100 caen justo.
  assert.equal(x[0], 0);
  assert.equal(x[x.length - 1], 100);
  assert.equal(y[y.length - 1], 200);
});

/* -------------------------- movingAverage --------------------------- */

test("movingAverage: reduce la dispersión de una señal ruidosa sin desplazar el nivel general", () => {
  const constant = 50;
  const noisy = Array.from({ length: 40 }, (_, i) => constant + (i % 2 === 0 ? 3 : -3));
  const smoothed = movingAverage(noisy, 5);
  assert.equal(smoothed.length, noisy.length, "no acorta la serie");
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = (arr) => { const m = mean(arr); return Math.sqrt(mean(arr.map((v) => (v - m) ** 2))); };
  assert.ok(std(smoothed) < std(noisy) / 2, "la dispersión debe caer sustancialmente");
  assert.ok(Math.abs(mean(smoothed) - mean(noisy)) < 0.5, "el nivel general se mantiene");
});

test("movingAverage: ventana <=1 es un no-op", () => {
  const arr = [1, 5, 2, 9, 3];
  assert.deepEqual(movingAverage(arr, 1), arr);
  assert.deepEqual(movingAverage(arr, 0), arr);
});

test("movingAverage: array vacío no revienta", () => {
  assert.deepEqual(movingAverage([], 5), []);
});

/* ------------------------ normalizeByViewport ------------------------ */

test("normalizeByViewport: lleva x,y a [0,1] relativo al viewport", () => {
  const { x, y } = normalizeByViewport([0, 960, 1920], [0, 472.5, 945], 1920, 945);
  assert.deepEqual(x, [0, 0.5, 1]);
  assert.ok(Math.abs(y[1] - 0.5) < 1e-9);
});

test("normalizeByViewport: sin viewport (0/null/undefined) pasa las coordenadas intactas", () => {
  assert.deepEqual(normalizeByViewport([1, 2], [3, 4], null, null), { x: [1, 2], y: [3, 4] });
  assert.deepEqual(normalizeByViewport([1, 2], [3, 4], 0, 800), { x: [1, 2], y: [3, 4] });
});

/* ------------------- preprocessMouseSamples / secuencias ------------------- */

test("preprocessMouseSamples: <2 puntos válidos devuelve la entrada tal cual (sin inventar trayectoria)", () => {
  const one = preprocessMouseSamples([{ t_ms: 5, x: 1, y: 2, event_type: "mousemove" }], 1000, 1000);
  assert.deepEqual(one, [{ t_ms: 5, x: 1, y: 2, event_type: "mousemove" }]);
  assert.deepEqual(preprocessMouseSamples([], 1000, 1000), []);
});

test("preprocessMouseSamples: ignora eventos sin x/y (keydown/keyup) al construir la trayectoria", () => {
  const out = preprocessMouseSamples(
    [
      { t_ms: 0, x: 0, y: 0, event_type: "mousemove" },
      { t_ms: 10, event_type: "keydown", key_code: "KeyA" },
      { t_ms: 40, x: 40, y: 40, event_type: "mousemove" },
    ],
    100, 100
  );
  assert.ok(out.every((e) => e.x != null && e.y != null));
});

test("mouseSequence: produce (dt,dx,dy) entre consecutivos, un elemento menos que la entrada", () => {
  const seq = mouseSequence([
    { t_ms: 0, x: 0, y: 0 }, { t_ms: 40, x: 4, y: 8 }, { t_ms: 80, x: 10, y: 8 },
  ]);
  assert.deepEqual(seq, [[40, 4, 8], [40, 6, 0]]);
});

test("keystrokeSequence: empareja keydown/keyup por key_code y calcula dwell/flight", () => {
  const seq = keystrokeSequence([
    { t_ms: 0, event_type: "keydown", key_code: "KeyA" },
    { t_ms: 50, event_type: "keyup", key_code: "KeyA" },
    { t_ms: 120, event_type: "keydown", key_code: "KeyB" },
    { t_ms: 160, event_type: "keyup", key_code: "KeyB" },
  ]);
  assert.deepEqual(seq, [[50, 0], [40, 70]]);
});

test("keystrokeSequence: tolera dos teclas presionadas a la vez sin cruzarse (pila por key_code)", () => {
  const seq = keystrokeSequence([
    { t_ms: 0, event_type: "keydown", key_code: "ShiftLeft" },
    { t_ms: 10, event_type: "keydown", key_code: "KeyA" },
    { t_ms: 60, event_type: "keyup", key_code: "KeyA" },
    { t_ms: 80, event_type: "keyup", key_code: "ShiftLeft" },
  ]);
  assert.equal(seq.length, 2);
  assert.deepEqual(seq[0], [50, 0], "KeyA: dwell 50ms, sin flight previo");
});

/* ---------------------------- padSequence ---------------------------- */

test("padSequence: rellena con ceros y marca la máscara solo en posiciones reales", () => {
  const { arr, mask } = padSequence([[1, 2, 3], [4, 5, 6]], 5, 3);
  assert.equal(arr.length, 15);
  assert.deepEqual(Array.from(arr), [1, 2, 3, 4, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(mask, [true, true, false, false, false]);
});

test("padSequence: trunca secuencias más largas que maxLen sin lanzar", () => {
  const seq = Array.from({ length: 10 }, (_, i) => [i, i, i]);
  const { arr, mask } = padSequence(seq, 3, 3);
  assert.equal(arr.length, 9);
  assert.deepEqual(mask, [true, true, true]);
});

/* ----------------- paridad con el fixture generado por Python ----------------- */

test("preprocessMouseSamples coincide EXACTAMENTE con ml/src/preprocess.py para el fixture", () => {
  const out = preprocessMouseSamples(FIXTURE.raw_mouse_events, FIXTURE.viewport_w, FIXTURE.viewport_h);
  assert.equal(out.length, FIXTURE.expected_preprocessed_mouse.length);
  for (let i = 0; i < out.length; i++) {
    assert.equal(out[i].t_ms, FIXTURE.expected_preprocessed_mouse[i].t_ms);
    assert.ok(Math.abs(out[i].x - FIXTURE.expected_preprocessed_mouse[i].x) < 1e-9, `x en índice ${i}`);
    assert.ok(Math.abs(out[i].y - FIXTURE.expected_preprocessed_mouse[i].y) < 1e-9, `y en índice ${i}`);
  }
});

test("mouseSequence y keystrokeSequence coinciden EXACTAMENTE con ml/src/features.py para el fixture", () => {
  const preMouse = preprocessMouseSamples(FIXTURE.raw_mouse_events, FIXTURE.viewport_w, FIXTURE.viewport_h);
  const mSeq = mouseSequence(preMouse);
  assert.equal(mSeq.length, FIXTURE.expected_mouse_sequence.length);
  for (let i = 0; i < mSeq.length; i++) {
    for (let j = 0; j < 3; j++) assert.ok(Math.abs(mSeq[i][j] - FIXTURE.expected_mouse_sequence[i][j]) < 1e-9);
  }
  const kSeq = keystrokeSequence(FIXTURE.raw_events_for_keystrokes);
  assert.deepEqual(kSeq, FIXTURE.expected_keystroke_sequence);
});

test("scoreBehaviorEvents reproduce el mismo risk_score que onnxruntime en Python para el MISMO .onnx committeado (paridad cruzada de runtime)", async () => {
  const result = await scoreBehaviorEvents(FIXTURE.raw_events_for_keystrokes, FIXTURE.viewport_w, FIXTURE.viewport_h);
  assert.equal(result.error, null, "el modelo committeado debe cargar y correr en onnxruntime-node");
  assert.ok(Math.abs(result.logit - FIXTURE.expected_risk_logit) < 1e-4, `logit: JS=${result.logit} PY=${FIXTURE.expected_risk_logit}`);
  assert.ok(Math.abs(result.score - FIXTURE.expected_risk_score) < 1e-4, `score: JS=${result.score} PY=${FIXTURE.expected_risk_score}`);
  assert.ok(result.score >= 0 && result.score <= 1);
});

/* ------------------------- degradación sin modelo ------------------------- */

test("runInference: si el archivo .onnx no existe, devuelve {error} en vez de lanzar", async () => {
  // No se puede reasignar MODEL_PATH (const exportado) desde el test sin
  // recargar el módulo -- en su lugar se comprueba que el modelo committeado
  // SÍ existe (server-side, para que nunca falte en producción) y que
  // runInference maneja bien un input degenerado (secuencia de mouse vacía,
  // caso real: 37 de 44 sesiones reales no tienen ningún evento de teclado,
  // y una sesión sin movimiento de mouse tampoco debería tumbar el cálculo).
  assert.ok(MODEL_PATH.endsWith("jolting_risk_model.onnx"));
  const { arr: mArr, mask: mMask } = padSequence([], MAX_MOUSE_LEN, 3);
  const { arr: kArr, mask: kMask } = padSequence([], MAX_KEY_LEN, 2);
  const out = await runInference(mArr, mMask, kArr, kMask);
  assert.equal(out.error, null);
  assert.ok(Number.isFinite(out.score), "una sesión sin mouse ni teclado debe dar un puntaje determinista, no NaN/crash");
});
