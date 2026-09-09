// Etiquetado fino de la captura conductual (TG §8.2.1 Tabla 1, módulo 7 --
// "Almacenamiento: eventos, etiquetas, resultados"), migración 008.
//
// Hasta ahora `behavior_events` guardaba solo la materia prima (una fila por
// muestra de mouse/teclado, migración 004) -- suficiente para exportar un
// CSV y que el pipeline de Python (ml/src/features.py, ml/src/preprocess.py)
// calculara AUC/SE/MD, latencias de tecleo y sus z-scores, pero solo
// EJECUTANDO ese pipeline aparte. Este módulo persiste esas mismas features
// YA CALCULADAS por sesión (`behavior_session_features`), para que el
// dashboard/exportación no dependan de correr Python cada vez -- cierra la
// fila que seguía en amarillo de la Tabla 1 una vez que preprocesamiento y
// representación (módulos 2-3) ya estaban listos.
//
// Igual que en riskScore.js, esto es un PUERTO deliberado de
// ml/src/features.py (mouse_trajectory_features, keystroke_features) y
// ml/src/preprocess.py (compute_calibration_baselines, zscore,
// baseline_for) -- no una reinterpretación libre. La paridad se verifica
// con un fixture generado por el propio Python (ver
// ml/scripts/gen_features_fixture.py y tests/unit/behaviorFeatures.test.js).
//
// Por qué esto es un job por lote (recomputeSessionFeatures), no algo que
// se dispare en cada POST /behavior como el puntaje de riesgo: una sesión
// de captura no tiene una señal de "cerrada" (el navegador solo hace flush
// periódico), y la línea base de calibración de CADA participante depende
// de comparar contra TODAS las sesiones del conjunto -- recalcularla en
// cada lote sería trabajo repetido sin ningún beneficio (esto no gatea
// nada en tiempo real, es almacenamiento para análisis). Se dispara a
// pedido desde el panel admin (`POST /api/dashboard/recompute-features`),
// el mismo criterio que ya usa la corrida de `python3 -m src.evaluate`.
import { query, withTransaction } from "../db.js";
import { preprocessMouseSamples } from "./riskScore.js";

// Versión de ESTE código de cálculo (no del modelo -- no hay modelo acá,
// son fórmulas deterministas). Se sube a mano si algún día cambia la
// definición de alguna feature, para poder distinguir filas viejas de
// nuevas en `behavior_session_features.feature_version` sin necesidad de
// recalcular fechas de commit.
export const FEATURE_VERSION = "js-v1";

// ---------------------------------------------------------------------------
// Estadística mínima -- dos variantes, A PROPÓSITO no unificadas: Python usa
// una std MUESTRAL (ddof=1, /(-n-1)) dentro de features.py, pero una std
// POBLACIONAL (ddof=0, numpy .std() por defecto) para la línea base de
// calibración en preprocess.py. Mezclar las dos daría números sutilmente
// distintos a los del pipeline de Python.
// ---------------------------------------------------------------------------

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0.0;
}

// Puerto de features._std: desviación estándar MUESTRAL (ddof=1).
function stdSample(xs) {
  if (xs.length < 2) return 0.0;
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

// Puerto de preprocess._safe_mean_std: desviación estándar POBLACIONAL
// (ddof=0, como numpy .std() por defecto), con piso de 1.0 para no dividir
// por (casi) cero al z-scorear después.
export function safeMeanStd(values) {
  if (values.length === 0) return [0.0, 1.0];
  const m = mean(values);
  const variance = values.reduce((acc, x) => acc + (x - m) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  return [m, std > 1e-9 ? std : 1.0];
}

// ---------------------------------------------------------------------------
// Puerto de ml/src/features.py
// ---------------------------------------------------------------------------

// Puerto de features._perpendicular_distances.
function perpendicularDistances(points) {
  if (points.length < 2) return points.map(() => 0.0);
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const dx = bx - ax, dy = by - ay;
  const lineLen = Math.hypot(dx, dy);
  return points.map(([px, py]) => {
    if (lineLen === 0) return Math.hypot(px - ax, py - ay);
    const cross = Math.abs(dx * (ay - py) - (ax - px) * dy);
    return cross / lineLen;
  });
}

// Puerto de features.mouse_trajectory_features. `samples`: {t_ms,x,y}[],
// ya ordenados por t_ms (típicamente ya preprocesados con
// preprocessMouseSamples). <2 puntos válidos -> features en cero, igual
// que en Python (no es un error, es una sesión sin trayectoria que describir).
export function mouseTrajectoryFeatures(samples) {
  const pts = samples
    .filter((s) => s.x != null && s.y != null)
    .map((s) => [s.t_ms, s.x, s.y]);
  if (pts.length < 2) {
    const n = pts.length;
    return {
      n_points: n, auc: 0.0, se: 0.0, md: 0.0, path_length: 0.0,
      straight_line_distance: 0.0, efficiency: 1.0,
      mean_velocity: 0.0, std_velocity: 0.0, mean_acceleration: 0.0, std_acceleration: 0.0,
    };
  }
  const xy = pts.map(([, x, y]) => [x, y]);
  const dists = perpendicularDistances(xy);
  const n = dists.length;
  const step = 1.0 / (n - 1);
  let auc = 0.0;
  for (let i = 0; i < n - 1; i++) auc += step * (dists[i] + dists[i + 1]) / 2.0;
  const se = stdSample(dists) / Math.sqrt(n);
  const md = mean(dists);

  let pathLength = 0.0;
  for (let i = 0; i < n - 1; i++) pathLength += Math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]);
  const straight = Math.hypot(xy[n - 1][0] - xy[0][0], xy[n - 1][1] - xy[0][1]);
  const efficiency = pathLength > 0 ? Math.min(straight / pathLength, 1.0) : 1.0;

  const velocities = [];
  for (let i = 0; i < n - 1; i++) {
    const dt = pts[i + 1][0] - pts[i][0];
    if (dt <= 0) continue;
    const d = Math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]);
    velocities.push(d / dt);
  }
  const accelerations = [];
  for (let i = 0; i < velocities.length - 1; i++) accelerations.push(velocities[i + 1] - velocities[i]);

  return {
    n_points: n, auc, se, md, path_length: pathLength, straight_line_distance: straight, efficiency,
    mean_velocity: mean(velocities), std_velocity: stdSample(velocities),
    mean_acceleration: mean(accelerations), std_acceleration: stdSample(accelerations),
  };
}

// Puerto de features.keystroke_features. Igual que en Python: dwell time =
// keyup-keydown de LA MISMA tecla (pila por key_code); flight time =
// keydown - keyup ANTERIOR (cualquier tecla). Solo usa tiempos y
// `key_code` (la tecla física) -- nunca el carácter escrito.
export function keystrokeFeatures(events) {
  const evs = events.filter((e) => e.event_type === "keydown" || e.event_type === "keyup");
  const openByKey = new Map();
  const dwellTimes = [];
  let lastKeyupT = null;
  const flightTimes = [];
  for (const e of evs) {
    const code = e.key_code || "?";
    if (e.event_type === "keydown") {
      if (lastKeyupT != null) {
        const flight = e.t_ms - lastKeyupT;
        if (flight >= 0) flightTimes.push(flight);
      }
      if (!openByKey.has(code)) openByKey.set(code, []);
      openByKey.get(code).push(e.t_ms);
    } else {
      const stack = openByKey.get(code);
      if (stack && stack.length) {
        const downT = stack.pop();
        const dwell = e.t_ms - downT;
        if (dwell >= 0) dwellTimes.push(dwell);
      }
      lastKeyupT = e.t_ms;
    }
  }
  return {
    n_keys: dwellTimes.length,
    mean_dwell_ms: mean(dwellTimes), std_dwell_ms: stdSample(dwellTimes),
    mean_flight_ms: mean(flightTimes), std_flight_ms: stdSample(flightTimes),
  };
}

// ---------------------------------------------------------------------------
// Puerto de ml/src/preprocess.py: línea base de calibración y z-score.
// ---------------------------------------------------------------------------

// Puerto de preprocess.zscore.
export function zscore(value, mean_, std) {
  return std ? (value - mean_) / std : 0.0;
}

// Puerto de preprocess.compute_calibration_baselines. `sessions`: Map de
// sessionId -> {meta: {phase, participant_campaign_id, viewport_w,
// viewport_h}, events: [...]}. Devuelve un Map con una entrada "personal"
// por participant_campaign_id que tenga una sesión de fase 'calibration' en
// el conjunto, más la entrada especial "__population__" (media/desviación
// sobre TODAS las sesiones del conjunto, calibración incluida -- igual que
// en Python).
export function computeCalibrationBaselines(sessions) {
  const byPcCalibration = new Map();
  for (const [, { meta, events }] of sessions) {
    if (meta.phase === "calibration" && meta.participant_campaign_id) {
      byPcCalibration.set(meta.participant_campaign_id, { meta, events });
    }
  }

  const baselines = new Map();
  for (const [pc, { meta, events }] of byPcCalibration) {
    const preMouse = preprocessMouseSamples(events, meta.viewport_w, meta.viewport_h);
    const mf = mouseTrajectoryFeatures(preMouse);
    const kf = keystrokeFeatures(events);
    baselines.set(pc, {
      mouse_velocity_mean: mf.mean_velocity, mouse_velocity_std: mf.std_velocity || 1.0,
      dwell_mean: kf.mean_dwell_ms, dwell_std: kf.std_dwell_ms || 1.0,
      flight_mean: kf.mean_flight_ms, flight_std: kf.std_flight_ms || 1.0,
      source: "personal",
    });
  }

  const allVelocities = [], allDwells = [], allFlights = [];
  for (const [, { meta, events }] of sessions) {
    const preMouse = preprocessMouseSamples(events, meta.viewport_w, meta.viewport_h);
    const mf = mouseTrajectoryFeatures(preMouse);
    const kf = keystrokeFeatures(events);
    if (mf.n_points >= 2) allVelocities.push(mf.mean_velocity);
    if (kf.n_keys > 0) {
      allDwells.push(kf.mean_dwell_ms);
      allFlights.push(kf.mean_flight_ms);
    }
  }
  const [vmean, vstd] = safeMeanStd(allVelocities);
  const [dmean, dstd] = safeMeanStd(allDwells);
  const [fmean, fstd] = safeMeanStd(allFlights);
  baselines.set("__population__", {
    mouse_velocity_mean: vmean, mouse_velocity_std: vstd,
    dwell_mean: dmean, dwell_std: dstd,
    flight_mean: fmean, flight_std: fstd,
    source: "poblacional",
  });
  return baselines;
}

// Puerto de preprocess.baseline_for: la personal si existe, si no la
// poblacional -- nunca devuelve nada vacío.
export function baselineFor(participantCampaignId, baselines) {
  if (participantCampaignId && baselines.has(participantCampaignId)) {
    return baselines.get(participantCampaignId);
  }
  return baselines.get("__population__");
}

// Combina mouse + teclado + z-score para UNA sesión, dado el conjunto de
// baselines ya calculado para el lote completo.
export function computeSessionFeatureRecord(sessionId, meta, events, baselines) {
  const preMouse = preprocessMouseSamples(events, meta.viewport_w, meta.viewport_h);
  const mf = mouseTrajectoryFeatures(preMouse);
  const kf = keystrokeFeatures(events);
  const b = baselineFor(meta.participant_campaign_id, baselines);
  return {
    session_id: sessionId,
    participant_campaign_id: meta.participant_campaign_id,
    phase: meta.phase,
    mouse: mf,
    key: kf,
    mouse_mean_velocity_z: zscore(mf.mean_velocity, b.mouse_velocity_mean, b.mouse_velocity_std),
    key_mean_dwell_ms_z: zscore(kf.mean_dwell_ms, b.dwell_mean, b.dwell_std),
    key_mean_flight_ms_z: zscore(kf.mean_flight_ms, b.flight_mean, b.flight_std),
    baseline_z_source: b.source,
  };
}

// ---------------------------------------------------------------------------
// Integración con Postgres: recalcula y persiste las features de TODAS las
// sesiones (o las de una campaña, con `campaignId`) en una sola pasada,
// igual que build_feature_table() en Python pero desde Node y directo a
// `behavior_session_features` (migración 008) en vez de a un DataFrame.
// Corre dentro de una transacción: o quedan todas las filas de esta pasada,
// o ninguna -- nunca una tabla a medio recalcular.
// ---------------------------------------------------------------------------

export async function recomputeSessionFeatures({ campaignId } = {}) {
  const params = [];
  let where = "";
  if (campaignId) {
    params.push(campaignId);
    where = `WHERE pc.campaign_id = $${params.length}`;
  }
  const result = await query(
    `SELECT bs.id AS session_id, pc.id AS participant_campaign_id, bs.phase,
            bs.viewport_w, bs.viewport_h,
            be.t_ms, be.event_type, be.x, be.y, be.key_code
     FROM behavior_events be
     JOIN behavior_sessions bs    ON bs.id = be.behavior_session_id
     JOIN participant_campaign pc ON pc.id = bs.participant_campaign_id
     ${where}
     ORDER BY bs.id, be.t_ms`,
    params
  );

  const sessions = new Map();
  for (const row of result.rows) {
    if (!sessions.has(row.session_id)) {
      sessions.set(row.session_id, {
        meta: {
          participant_campaign_id: row.participant_campaign_id,
          phase: row.phase,
          viewport_w: row.viewport_w,
          viewport_h: row.viewport_h,
        },
        events: [],
      });
    }
    sessions.get(row.session_id).events.push({
      t_ms: row.t_ms, event_type: row.event_type, x: row.x, y: row.y, key_code: row.key_code,
    });
  }
  if (sessions.size === 0) return { computed: 0, campaign_id: campaignId || null };

  const baselines = computeCalibrationBaselines(sessions);
  const records = [];
  for (const [sessionId, { meta, events }] of sessions) {
    records.push(computeSessionFeatureRecord(sessionId, meta, events, baselines));
  }

  await withTransaction(async (client) => {
    for (const rec of records) {
      await client.query(
        `INSERT INTO behavior_session_features (
           session_id, participant_campaign_id, phase,
           mouse_n_points, mouse_auc, mouse_se, mouse_md, mouse_path_length,
           mouse_straight_line_distance, mouse_efficiency, mouse_mean_velocity,
           mouse_std_velocity, mouse_mean_acceleration, mouse_std_acceleration,
           key_n_keys, key_mean_dwell_ms, key_std_dwell_ms, key_mean_flight_ms, key_std_flight_ms,
           mouse_mean_velocity_z, key_mean_dwell_ms_z, key_mean_flight_ms_z,
           baseline_z_source, feature_version, computed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24, now())
         ON CONFLICT (session_id) DO UPDATE SET
           participant_campaign_id = EXCLUDED.participant_campaign_id,
           phase = EXCLUDED.phase,
           mouse_n_points = EXCLUDED.mouse_n_points,
           mouse_auc = EXCLUDED.mouse_auc,
           mouse_se = EXCLUDED.mouse_se,
           mouse_md = EXCLUDED.mouse_md,
           mouse_path_length = EXCLUDED.mouse_path_length,
           mouse_straight_line_distance = EXCLUDED.mouse_straight_line_distance,
           mouse_efficiency = EXCLUDED.mouse_efficiency,
           mouse_mean_velocity = EXCLUDED.mouse_mean_velocity,
           mouse_std_velocity = EXCLUDED.mouse_std_velocity,
           mouse_mean_acceleration = EXCLUDED.mouse_mean_acceleration,
           mouse_std_acceleration = EXCLUDED.mouse_std_acceleration,
           key_n_keys = EXCLUDED.key_n_keys,
           key_mean_dwell_ms = EXCLUDED.key_mean_dwell_ms,
           key_std_dwell_ms = EXCLUDED.key_std_dwell_ms,
           key_mean_flight_ms = EXCLUDED.key_mean_flight_ms,
           key_std_flight_ms = EXCLUDED.key_std_flight_ms,
           mouse_mean_velocity_z = EXCLUDED.mouse_mean_velocity_z,
           key_mean_dwell_ms_z = EXCLUDED.key_mean_dwell_ms_z,
           key_mean_flight_ms_z = EXCLUDED.key_mean_flight_ms_z,
           baseline_z_source = EXCLUDED.baseline_z_source,
           feature_version = EXCLUDED.feature_version,
           computed_at = now()`,
        [
          rec.session_id, rec.participant_campaign_id, rec.phase,
          rec.mouse.n_points, rec.mouse.auc, rec.mouse.se, rec.mouse.md, rec.mouse.path_length,
          rec.mouse.straight_line_distance, rec.mouse.efficiency, rec.mouse.mean_velocity,
          rec.mouse.std_velocity, rec.mouse.mean_acceleration, rec.mouse.std_acceleration,
          rec.key.n_keys, rec.key.mean_dwell_ms, rec.key.std_dwell_ms, rec.key.mean_flight_ms, rec.key.std_flight_ms,
          rec.mouse_mean_velocity_z, rec.key_mean_dwell_ms_z, rec.key_mean_flight_ms_z,
          rec.baseline_z_source, FEATURE_VERSION,
        ]
      );
    }
  });

  return { computed: records.length, campaign_id: campaignId || null };
}
