// Pruebas unitarias de la captura biométrica facial (migración 015) --
// lib/facialFeatures.js, sin Postgres.
//
// A diferencia de behaviorFeatures.test.js, no hay un fixture de Python
// contra el cual verificar paridad (facialFeatures.js no es un puerto de un
// cálculo ya validado en ml/ -- son fórmulas nuevas sobre los escalares que
// deriva facial-capture.js, documentadas en la cabecera de ese archivo).
// Estas pruebas verifican casos de valor conocido construidos a mano.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  facialSessionFeatures, computeCalibrationBaselines, baselineFor,
  computeFacialSessionFeatureRecord,
} from "../../src/lib/facialFeatures.js";

function sample(t_ms, overrides = {}) {
  return {
    t_ms, face_detected: true, eye_openness: 0.9, blink: false,
    gaze_x: 0, gaze_y: 0, brow_tension: 0.1, mouth_tension: 0.1,
    ...overrides,
  };
}

/* --------------------------- facialSessionFeatures --------------------------- */

test("facialSessionFeatures: sin muestras -> todo en cero, no revienta", () => {
  const f = facialSessionFeatures([]);
  assert.equal(f.n_samples, 0);
  assert.equal(f.face_detected_ratio, 0);
  assert.equal(f.blink_count, 0);
  assert.equal(f.blink_rate_per_min, 0);
});

test("facialSessionFeatures: face_detected_ratio refleja la fracción de muestras con rostro detectado", () => {
  const samples = [
    sample(0, { face_detected: false, eye_openness: null, brow_tension: null, mouth_tension: null }),
    sample(66),
    sample(132),
    sample(198, { face_detected: false, eye_openness: null, brow_tension: null, mouth_tension: null }),
  ];
  const f = facialSessionFeatures(samples);
  assert.equal(f.n_samples, 4);
  assert.ok(Math.abs(f.face_detected_ratio - 0.5) < 1e-9);
});

test("facialSessionFeatures: un tramo de muestras 'blink=true' consecutivas cuenta como UN solo parpadeo", () => {
  // ~15 Hz (66ms), un parpadeo de ~200ms típico dura 3 muestras seguidas.
  const samples = [
    sample(0, { blink: false }),
    sample(66, { blink: true, eye_openness: 0.1 }),
    sample(132, { blink: true, eye_openness: 0.1 }),
    sample(198, { blink: true, eye_openness: 0.1 }),
    sample(264, { blink: false }),
    sample(60000, { blink: true, eye_openness: 0.1 }), // un segundo parpadeo, bien separado
    sample(60066, { blink: false }),
  ];
  const f = facialSessionFeatures(samples);
  assert.equal(f.blink_count, 2, "3 muestras seguidas en blink=true es UN parpadeo, no tres");
});

test("facialSessionFeatures: una pérdida de detección en medio de un parpadeo no lo cuenta dos veces por error, pero tampoco lo funde con el siguiente", () => {
  const samples = [
    sample(0, { blink: true, eye_openness: 0.1 }),
    sample(66, { face_detected: false, eye_openness: null, brow_tension: null, mouth_tension: null, blink: null }),
    sample(132, { blink: true, eye_openness: 0.1 }),
  ];
  const f = facialSessionFeatures(samples);
  // El corte de detección interrumpe el tramo: esto se cuenta como dos
  // parpadeos separados por diseño (ver countBlinkEvents) -- es preferible a
  // asumir continuidad sobre datos que en ese instante no existen.
  assert.equal(f.blink_count, 2);
});

test("facialSessionFeatures: blink_rate_per_min se calcula sobre la duración real de la sesión (t_ms final - inicial)", () => {
  // Un parpadeo en una sesión de exactamente 30s (30000ms) -> 2 parpadeos/min.
  const samples = [
    sample(0, { blink: true, eye_openness: 0.1 }),
    sample(66, { blink: false }),
    sample(30000, { blink: false }),
  ];
  const f = facialSessionFeatures(samples);
  assert.equal(f.blink_count, 1);
  assert.ok(Math.abs(f.blink_rate_per_min - 2.0) < 1e-9, `esperado 2.0, dio ${f.blink_rate_per_min}`);
});

test("facialSessionFeatures: gaze_mean_abs_x/y mide magnitud de desvío del centro, no se cancela con signo", () => {
  const samples = [
    sample(0, { gaze_x: 0.6 }),
    sample(66, { gaze_x: -0.6 }),
  ];
  const f = facialSessionFeatures(samples);
  assert.ok(Math.abs(f.gaze_mean_abs_x - 0.6) < 1e-9, "el promedio de |gaze_x| no debe cancelarse a 0 como el promedio simple");
});

test("facialSessionFeatures: muestras sin rostro (face_detected=false) no contaminan los promedios de señal", () => {
  const samples = [
    sample(0, { brow_tension: 0.2 }),
    sample(66, { face_detected: false, eye_openness: null, brow_tension: null, mouth_tension: null, blink: null }),
    sample(132, { brow_tension: 0.4 }),
  ];
  const f = facialSessionFeatures(samples);
  assert.ok(Math.abs(f.brow_tension_mean - 0.3) < 1e-9);
});

/* ----------------- computeCalibrationBaselines / baselineFor ----------------- */

function sessionsMapFrom(entries) {
  // entries: [[sessionId, participant_campaign_id, phase, samples], ...]
  const m = new Map();
  for (const [sid, pcId, phase, samples] of entries) {
    m.set(sid, { meta: { participant_campaign_id: pcId, phase }, samples });
  }
  return m;
}

test("computeCalibrationBaselines + baselineFor: un participante con sesión de calibración usa línea base PERSONAL", () => {
  const calibSamples = [sample(0, { brow_tension: 0.1 }), sample(66, { brow_tension: 0.1 })];
  const appSamples = [sample(0, { brow_tension: 0.5 })];
  const sessions = sessionsMapFrom([
    ["s1", "pcA", "calibration", calibSamples],
    ["s2", "pcA", "app", appSamples],
    ["s3", "pcB", "app", appSamples], // pcB nunca tuvo calibración
  ]);
  const baselines = computeCalibrationBaselines(sessions);
  assert.equal(baselineFor("pcA", baselines).source, "personal");
  assert.equal(baselineFor("pcB", baselines).source, "poblacional");
  assert.equal(baselineFor("pcNuncaVisto", baselines).source, "poblacional");
});

test("computeFacialSessionFeatureRecord: una sesión con tensión de ceja muy por encima de su propia calibración da un z-score alto y positivo", () => {
  const calibSamples = Array.from({ length: 10 }, (_, i) => sample(i * 66, { brow_tension: 0.1 }));
  const tenseSamples = Array.from({ length: 10 }, (_, i) => sample(i * 66, { brow_tension: 0.9 }));
  const sessions = sessionsMapFrom([
    ["calib", "pcA", "calibration", calibSamples],
    ["tense", "pcA", "message", tenseSamples],
  ]);
  const baselines = computeCalibrationBaselines(sessions);
  const rec = computeFacialSessionFeatureRecord("tense", { participant_campaign_id: "pcA", phase: "message" }, tenseSamples, baselines);
  assert.equal(rec.baseline_z_source, "personal");
  assert.ok(rec.brow_tension_mean_z > 0, `esperado z-score positivo (más tenso que su propia calibración), dio ${rec.brow_tension_mean_z}`);
});
