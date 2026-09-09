// Pruebas unitarias del etiquetado fino (TG §8.2.1 Tabla 1, módulo 7,
// migración 008) -- lib/behaviorFeatures.js, sin Postgres.
//
// Dos tipos de prueba, mismo criterio que tests/unit/riskScore.test.js:
//
// 1. Casos de valor conocido (línea recta perfecta -> AUC=SE=MD=0, dwell/
//    flight de un par de teclas simple) -- igual patrón que
//    ml/tests/test_features.py, pero aquí importa que el puerto a JS no se
//    haya desviado.
// 2. Paridad contra un fixture generado por el propio Python
//    (ml/scripts/gen_features_fixture.py -> tests/fixtures/
//    behavior_features_fixture.json): tres sesiones sintéticas que
//    ejercitan AMBOS caminos de baseline_for (personal y poblacional),
//    comparadas número a número contra ml/src/features.py y
//    ml/src/preprocess.py corriendo en Python de verdad.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mouseTrajectoryFeatures, keystrokeFeatures, safeMeanStd, zscore,
  computeCalibrationBaselines, baselineFor, computeSessionFeatureRecord,
} from "../../src/lib/behaviorFeatures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(path.join(__dirname, "..", "fixtures", "behavior_features_fixture.json"), "utf-8"));

/* ------------------------- mouseTrajectoryFeatures ------------------------- */

test("mouseTrajectoryFeatures: línea recta perfecta -> AUC=SE=MD=0, eficiencia=1", () => {
  const samples = Array.from({ length: 6 }, (_, i) => ({ t_ms: i * 40, x: i * 10, y: i * 10 }));
  const f = mouseTrajectoryFeatures(samples);
  assert.equal(f.auc, 0);
  assert.equal(f.se, 0);
  assert.equal(f.md, 0);
  assert.ok(Math.abs(f.efficiency - 1.0) < 1e-9);
  assert.equal(f.n_points, 6);
});

test("mouseTrajectoryFeatures: <2 puntos válidos da features en cero, no revienta", () => {
  assert.deepEqual(mouseTrajectoryFeatures([]).n_points, 0);
  const one = mouseTrajectoryFeatures([{ t_ms: 0, x: 1, y: 1 }]);
  assert.equal(one.n_points, 1);
  assert.equal(one.auc, 0);
  assert.equal(one.efficiency, 1.0);
});

test("mouseTrajectoryFeatures: ignora muestras sin x/y", () => {
  const f = mouseTrajectoryFeatures([
    { t_ms: 0, x: 0, y: 0 },
    { t_ms: 10, event_type: "keydown" }, // sin x/y -- debe filtrarse
    { t_ms: 40, x: 40, y: 0 },
  ]);
  assert.equal(f.n_points, 2);
});

/* --------------------------- keystrokeFeatures --------------------------- */

test("keystrokeFeatures: un par simple da dwell = keyup-keydown, flight = 0 (sin tecla previa)", () => {
  const f = keystrokeFeatures([
    { t_ms: 100, event_type: "keydown", key_code: "KeyA" },
    { t_ms: 150, event_type: "keyup", key_code: "KeyA" },
  ]);
  assert.equal(f.n_keys, 1);
  assert.equal(f.mean_dwell_ms, 50);
  assert.equal(f.mean_flight_ms, 0, "sin keyup anterior no hay flight que contar");
});

test("keystrokeFeatures: dos teclas consecutivas -- flight = gap entre keyup y el siguiente keydown", () => {
  const f = keystrokeFeatures([
    { t_ms: 0, event_type: "keydown", key_code: "KeyA" },
    { t_ms: 50, event_type: "keyup", key_code: "KeyA" },
    { t_ms: 120, event_type: "keydown", key_code: "KeyB" },
    { t_ms: 160, event_type: "keyup", key_code: "KeyB" },
  ]);
  assert.equal(f.n_keys, 2);
  assert.equal(f.mean_dwell_ms, 45); // (50 + 40) / 2
  assert.equal(f.mean_flight_ms, 70); // solo el segundo par tiene flight (120-50)
});

test("keystrokeFeatures: sin eventos de teclado -> n_keys=0, promedios en 0, no revienta", () => {
  const f = keystrokeFeatures([{ t_ms: 0, x: 1, y: 1, event_type: "mousemove" }]);
  assert.equal(f.n_keys, 0);
  assert.equal(f.mean_dwell_ms, 0);
});

/* ------------------------------ safeMeanStd / zscore ------------------------------ */

test("safeMeanStd: lista vacía -> [0, 1] (piso de std para no dividir por 0)", () => {
  assert.deepEqual(safeMeanStd([]), [0.0, 1.0]);
});

test("safeMeanStd: usa desviación POBLACIONAL (ddof=0), no muestral", () => {
  const [m, s] = safeMeanStd([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.ok(Math.abs(m - 5.0) < 1e-9);
  assert.ok(Math.abs(s - 2.0) < 1e-9, `std poblacional esperada 2.0, dio ${s}`);
});

test("zscore: std=0 -> 0.0 en vez de Infinity/NaN", () => {
  assert.equal(zscore(10, 5, 0), 0.0);
  assert.equal(zscore(10, 5, 5), 1.0);
});

/* ----------------- paridad con el fixture generado por Python ----------------- */

for (const [sessionId, expected] of Object.entries(FIXTURE.sessions)) {
  test(`${sessionId}: mouse_trajectory_features/keystroke_features coinciden con Python`, () => {
    // No repetimos aquí el preprocesamiento (ya verificado bit a bit en
    // riskScore.test.js) -- computeSessionFeatureRecord lo aplica
    // internamente, así que basta con comparar su salida contra lo que
    // Python calculó sobre los MISMOS eventos crudos.
    const baselines = computeCalibrationBaselines(fixtureSessionsMap());
    const meta = {
      participant_campaign_id: expected.participant_campaign_id,
      phase: expected.phase,
      viewport_w: FIXTURE.viewport_w,
      viewport_h: FIXTURE.viewport_h,
    };
    const rec = computeSessionFeatureRecord(sessionId, meta, expected.raw_events, baselines);

    for (const key of Object.keys(expected.expected_mouse_features)) {
      const got = rec.mouse[key];
      const want = expected.expected_mouse_features[key];
      assert.ok(Math.abs(got - want) < 1e-6, `mouse.${key}: JS=${got} PY=${want}`);
    }
    for (const key of Object.keys(expected.expected_key_features)) {
      const got = rec.key[key];
      const want = expected.expected_key_features[key];
      assert.ok(Math.abs(got - want) < 1e-6, `key.${key}: JS=${got} PY=${want}`);
    }
    assert.equal(rec.baseline_z_source, expected.expected_baseline_source);
    assert.ok(Math.abs(rec.mouse_mean_velocity_z - expected.expected_mouse_mean_velocity_z) < 1e-6);
    assert.ok(Math.abs(rec.key_mean_dwell_ms_z - expected.expected_key_mean_dwell_ms_z) < 1e-6);
    assert.ok(Math.abs(rec.key_mean_flight_ms_z - expected.expected_key_mean_flight_ms_z) < 1e-6);
  });
}

test("computeCalibrationBaselines: línea base poblacional coincide con Python (incluye la sesión de calibración)", () => {
  const baselines = computeCalibrationBaselines(fixtureSessionsMap());
  const pop = baselines.get("__population__");
  const want = FIXTURE.expected_population_baseline;
  assert.ok(Math.abs(pop.mouse_velocity_mean - want.mouse_velocity_mean) < 1e-9);
  assert.ok(Math.abs(pop.mouse_velocity_std - want.mouse_velocity_std) < 1e-9);
  assert.ok(Math.abs(pop.dwell_mean - want.dwell_mean) < 1e-9);
  assert.ok(Math.abs(pop.flight_mean - want.flight_mean) < 1e-9);
});

test("computeCalibrationBaselines + baselineFor: pcA usa su línea PERSONAL, pcB cae a la POBLACIONAL", () => {
  const baselines = computeCalibrationBaselines(fixtureSessionsMap());
  assert.equal(baselineFor("pcA", baselines).source, "personal");
  assert.equal(baselineFor("pcB", baselines).source, "poblacional");
  assert.equal(baselineFor("pcNuncaVisto", baselines).source, "poblacional", "un participante desconocido también cae al respaldo poblacional");
});

function fixtureSessionsMap() {
  const m = new Map();
  for (const [sid, s] of Object.entries(FIXTURE.sessions)) {
    m.set(sid, {
      meta: {
        participant_campaign_id: s.participant_campaign_id,
        phase: s.phase,
        viewport_w: FIXTURE.viewport_w,
        viewport_h: FIXTURE.viewport_h,
      },
      events: s.raw_events,
    });
  }
  return m;
}
